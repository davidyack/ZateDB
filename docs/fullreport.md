# BackendCache — Comprehensive Architectural Review (Third Pass: the HA Pivot)

**Date:** 2026-07-19 (third pass)
**Scope:** Full repository at commit `3f40031` — source (`src/`, including the new `src/cluster/`), tests, Dockerfile, Bicep infra, and docs.
**Context:** Since the second pass (at `65ca295`), PR #7 landed **multi-node high availability**: 2+ replicas behind Container Apps' internal TCP ingress, cross-node replication over an Azure Service Bus topic, and Cosmos DB as a durable backing store with startup hydration (~1,500 lines of new distributed-systems code plus 40 new tests). This is a fundamental architectural pivot — the two prior reviews were built around a documented single-replica invariant that this change deliberately retires. This pass reviews the HA design and implementation, re-checks the second pass's open items, and re-scores every lens.
**Verification:** typecheck clean, **142/142 tests passing** at head (including the new `clusterCoordinator`, `dispatcherReplication`, `haReplication`, and `adminServer` suites).

---

## Status of the Second-Pass Top 10

PR #7 went a different direction (HA) rather than working the second-pass list; most items remain open, and several got *more* important because HA multiplies their cost:

| Second-pass item | Status |
|---|---|
| 1. Memory ceiling not enforced on existing-key growth | **Open** — and HA adds two more deliberate bypasses: replicated applies and startup hydration skip the ceiling entirely (see new findings) |
| 2. O(entry-size) accounting on hash/zset writes | **Open** — now also paid on every *replicated* apply, so a busy peer's writes tax this node too |
| 3. O(keyspace) `stats()` walk per metric scrape | **Open** — and the new cluster heartbeat calls `store.stats()` every 10 s on top of it |
| 4. Failed-`AUTH` throttling | **Open** |
| 5. Incremental TTL sweep | **Open** |
| 6. Digest-pinned base image + `npm audit` in CI | **Open** |
| 7. Slow-command log + sweep-duration metric | **Open** (subscription lifecycle logging was added — useful, adjacent) |
| 8. Bounded crash-path shutdown | **Open** — and shutdown now also awaits `cluster.stop()` (Service Bus/Cosmos calls), lengthening the unbounded tail |
| 9. Admin-port reachability docs + runbook | **Open** — more pressing now that `/admin/nodes` is the cluster-membership view |
| 10. Load-test ceilings, dead-code nits | **Open** — and the question is bigger now: replication adds a Cosmos write + Service Bus publish per mutation |

One second-pass recommendation *was* effectively delivered by the HA work: a true readiness/liveness split (`/readyz` gates on hydration; `/healthz` never does), correctly wired into the Bicep probes.

---

## Top 10 Changes to Make Today (Third Pass)

Ranked by severity × immediacy. Items 1–3 are latent production incidents; 4–5 protect the cost model and the flagship use case; 6–10 harden the new distributed layer and carry forward the still-open floor.

| # | Change | Why | Where |
|---|--------|-----|-------|
| 1 | **Fail fast in production when HA config is partial or missing — never silently run standalone at 2+ replicas.** The factory logs a warning and falls back to standalone on partial config, and absent config is silently standalone by design. But the Bicep now pins `minReplicas: 2`: a typo'd env var or missed secret yields **two or more independent, non-replicating nodes behind one connection-spraying load balancer** — per-connection divergent keyspaces, the exact correctness failure the old single-replica invariant existed to prevent, with only a warn-level log to notice. Add a `REQUIRE_HA=true` env (set in the Bicep) that makes standalone fallback a startup failure. | Split-brain-by-misconfiguration is the worst latent failure in the system today | `src/cluster/factory.ts`, `src/config.ts`, `infra/backendcache.bicep` |
| 2 | **Replicate `EXPIRE`/`PEXPIRE` as TTL-only events, not whole-entry upserts.** They're registered under the whole-key path, so an `EXPIRE` on a hash/zset snapshots this node's *entire entry* and `applyReplicatedUpsert` overwrites the whole key on every peer — destroying concurrently-written fields the origin node hasn't received yet. This breaks the field-granularity guarantee the design carefully builds for `HSET`/`ZADD` (and re-ships potentially large entries for a metadata change). Add a `ttl` event kind + a Cosmos patch on `/entry/expiresAtMs`. | The `INCR` + `EXPIRE` rate-limit idiom makes this race common on the busiest keys | `src/commands/dispatcher.ts`, `src/cluster/clusterCoordinator.ts`, `src/cluster/cosmosDurableStore.ts`, `src/store/store.ts` |
| 3 | **Enable Cosmos native document TTL and exclude expired docs from hydration.** Local lazy/sweep expiry calls `remove()` without replication (correctly — every node expires independently), so **expired documents are never deleted from Cosmos**. The keys container grows monotonically; `loadAll()` (`SELECT c.key, c.entry FROM c`, no expiry filter) re-loads every dead key on each restart; hydration gets slower forever and — since `applyReplicatedUpsert` bypasses the memory ceiling — eventually becomes a poison pill that OOMs every restarting node. Write a `ttl` property (seconds, from `expiresAtMs`) on upsert, enable TTL on the container, and add a `WHERE` clause to the hydration query. Log and bound hydration against `maxMemoryBytes`. | Unbounded storage growth + ever-slower startup + an eventual restart-loop OOM | `src/cluster/cosmosDurableStore.ts`, `src/cluster/clusterCoordinator.ts` |
| 4 | **Coalesce per-key replication writes, then run the RU math.** `enqueueForKey` correctly *serializes* same-key publishes but never *collapses* them: N rapid `INCR`s on a hot counter = N sequential Cosmos upserts + N Service Bus messages, each shipping an absolute value that supersedes the previous one. Replace queued-but-not-started tasks for the same key with the latest state (a one-slot pending map) — a large RU/ops reduction on exactly the hot-key workloads this system serves. Then price the result honestly: at ~100 mutating commands/s, per-write persistence is roughly 1,000 RU/s ≈ 86 M RU/day — hundreds of dollars/month serverless, an order of magnitude above the original "avoid a $16/month managed Redis" thesis. If the math doesn't close, consider not durably persisting short-TTL keys at all (Service-Bus-only replication; sub-minute counters reset on full-cluster restart anyway). | The cost thesis inverted; coalescing is today's code fix, the RU model is today's decision input | `src/cluster/clusterCoordinator.ts`, then `docs/high-availability.md` |
| 5 | **Replicate `INCR` as a delta, not an absolute value.** Cross-node concurrent `INCR`s currently converge last-write-wins — the counter *undercounts* precisely under the load spikes rate limiting exists for (fail-open during attack). Increments commute: ship `{kind:'increment', key, delta}` events (peers add the delta) and use Cosmos's atomic `incr` patch op for the durable value. This makes the flagship use case (shared counters) converge correctly with no consensus machinery — a G-counter in all but name. | Fixes the one consistency race that undermines the system's primary purpose | `src/cluster/`, `src/commands/dispatcher.ts`, `src/store/store.ts` |
| 6 | **Detect and recover replication-subscription death.** Receivers use `receiveAndDelete` with per-node subscriptions created at startup, `autoDeleteOnIdle: PT1H`, message TTL `PT5M`, and a `processError` handler that only logs. Failure chain: a quiet or partitioned node can lose its subscription (verify whether an idle-but-connected receiver resets the PT1H clock — Azure's idle semantics are notoriously subtle) or miss >5 min of messages, after which it **diverges silently forever** — there is no anti-entropy, no resubscribe, no self-check. Treat sustained receive errors / subscription-not-found as fatal (exit; the restart re-creates the subscription and re-hydrates), and add periodic incremental re-hydration (`WHERE c.updatedAtMs > @lastSync`) as a cheap convergence backstop. | "Replication quietly stopped" is undetectable today except by comparing nodes by hand | `src/cluster/serviceBusTransport.ts`, `src/cluster/clusterCoordinator.ts` |
| 7 | **Move to managed identity and least privilege for both Azure dependencies.** The Bicep wires connection strings: Service Bus with **Manage** rights (namespace-level create/delete of topics and subscriptions) and a Cosmos account key (full account access). The Cosmos code already supports AAD (`COSMOS_ENDPOINT` + `DefaultAzureCredential`); use it, add the same for Service Bus (Data Owner scoped to the one topic), and drop both secrets. Note the topic is now **part of the data plane's trust boundary**: any principal with Send rights can inject upsert/delete/publish events into every node's memory — document that and scope Send accordingly. | The HA layer regressed the security posture from "two narrow secrets" to "two broad ones" | `infra/backendcache.bicep`, `src/cluster/serviceBusTransport.ts`, `docs/security.md` |
| 8 | **Fix the O(keyspace)/O(entry) hot paths HA just multiplied.** The heartbeat calls `store.stats()` (full walk) every 10 s, the metrics gauge does the same per scrape, and the O(entry-size) accounting recompute now also runs on every replicated apply — a busy peer taxes every node's event loop. Expose the store's exact `memoryBytes` counter for the gauge/heartbeat and make accounting deltas incremental (second-pass items 2–3, now urgent). | Background overhead now scales with cluster write volume, not just local traffic | `src/store/store.ts`, `src/telemetry/saturation.ts`, `src/cluster/clusterCoordinator.ts` |
| 9 | **Test the consistency model you documented.** The HA docs make precise claims (no-op commands never replicate; mid-hydration events buffer and win over the snapshot; concurrent different-field writes both survive; same-key same-node writes stay ordered). The fake transport delivers synchronously and in order — add reorder/delay/drop/duplicate modes and turn each documented claim (plus the finding-2 `EXPIRE`-vs-`HSET` race, once fixed) into a test. Distributed invariants without adversarial tests decay into folklore. | The correctness surface moved from one process to a protocol; the tests must follow | `test/helpers/fakeCluster.ts`, `test/unit/`, `test/integration/` |
| 10 | **Carry forward the open operational floor.** Still outstanding from prior passes and unchanged in priority: failed-`AUTH` throttling; digest-pinned base image + `npm audit`/image scan in CI; a hard exit-timer on crash-path shutdown (now also covering `cluster.stop()`'s network calls); admin-port reachability + incident runbook (now including `/admin/nodes` and "how to tell whether replication is flowing"); the memory-ceiling existing-key-growth gap. | The single-node floor didn't get less necessary because a cluster now stands on it | various (see second-pass table) |

Everything below is the full re-assessed analysis.

---

<a name="system-overview"></a>
## System Overview

**Core business purpose.** Unchanged in function — a drop-in RESP2-compatible cache/pub-sub service for cross-replica rate limiting, presence, Socket.IO fan-out, and abuse guards — but **changed in promise**: state now survives node restarts, redeploys, and scale events. The system has moved from "ephemeral by contract" to "durable, eventually consistent by contract."

**The strategic question this pivot raises (stated plainly).** The original raison d'être was *"no external managed service required."* The HA design requires **two** managed Azure services (Cosmos DB + Service Bus), at least two replicas, and ~1,500 lines of bespoke replication code — while offering *weaker* consistency than a single managed Redis (last-write-wins races on counters vs. Redis's atomic `INCR`). There may be sound organizational reasons to prefer this shape (Cosmos/Service Bus already provisioned and governed, Redis procurement blocked, a hard durability requirement). But the decision should be made with the cost model of Top 10 #4 and this consistency comparison on the table — not inherited from momentum. The repo's own earlier architecture doc ("don't pre-build HA speculatively; revisit only if availability becomes a *measured* problem") sets the standard the pivot should be held to: if there is a measured availability problem, document it in `docs/high-availability.md`; if not, this is the speculative build the docs warned against, executed well.

**System boundaries and interfaces:**
1. **RESP TCP `:6379`** — data plane, per-node; ingress load-balances connections across replicas with no affinity (per-TCP-connection stickiness only).
2. **HTTP `:8081` `/healthz` + `/readyz`** — liveness vs. readiness now correctly split; readiness gates on hydration.
3. **HTTP `:8082` `/admin/*`** — now cluster-aware: `/admin/stats` and `/admin/pubsub` merge peer heartbeat snapshots; new `/admin/nodes` lists membership; admin `DELETE` correctly replicates cluster-wide.
4. **Azure Service Bus topic** (new) — replication fan-out: one shared topic, one auto-created subscription per node. **Now inside the data-plane trust boundary.**
5. **Cosmos DB** (new) — `keys` container as durable source of truth (hydration source), `nodes` container for heartbeats/topology.
6. **OTLP / Azure Monitor egress** — unchanged.

**Major components** (new/changed):
- `ClusterCoordinator` (`src/cluster/clusterCoordinator.ts`) — hydration (with correct event buffering during snapshot load), fire-and-forget replication with per-key ordering chains and shutdown drain, heartbeats.
- `CosmosDurableStore` — upserts/deletes plus field/member-granular Patch-API writes (JSON-Pointer-escaped, batched at Cosmos's 10-op limit, with a first-batch-404 document-creation fallback); base64url doc ids for Redis-hostile key names.
- `ServiceBusReplicationTransport` — topic/subscription lifecycle, `receiveAndDelete`, origin-node filtering.
- `dispatch` — replication centralized in the dispatcher via per-command `mutatedKeys`/`fieldReplication` declarations (handlers stay HA-unaware); no-op detection prevents phantom deletes; `HDEL`/`ZREMRANGEBYSCORE` capture before-state to replicate only members that actually existed.
- `Store` — `applyReplicated*` methods that never cascade replication and deliberately bypass admission control.
- Standalone mode: null implementations keep single-node behavior bit-identical and the test suite hermetic.

**Data flow (HA mode).** Client write → local synchronous mutation → RESP reply (fast path unchanged) → async: Cosmos upsert/patch ∥ Service Bus publish → each peer applies to its in-memory copy. Reads are always local. `PUBLISH` fans out locally then broadcasts for peers' local subscribers; never persisted (correctly matching Redis pub/sub semantics).

**Key architectural decisions and drivers:**

| Decision | Driver | Assessment |
|---|---|---|
| Multi-master, eventually consistent, no consensus | Simplicity; any node serves any client; LB has no affinity | Coherent and honestly documented; the residual races that matter are findings #2/#5, and the counter race hits the flagship use case |
| Every node holds the full keyspace | Local-read latency; no routing layer | Sound at target scale; caps cluster capacity at one node's memory — growth path is still namespace sharding, now per-cluster |
| Replication centralized in dispatcher via declarative specs | A new mutating command can't silently skip replication | Genuinely good design — the kind of "make the wrong thing unwritable" structure worth propagating |
| Field/member-granular replication, never downgraded to whole-key delete | Concurrent different-field writes must both survive | Correct and subtle — undermined only by the EXPIRE whole-entry path (finding #2) |
| Fire-and-forget replication, drain on shutdown | Client latency must not pay for Cosmos/Service Bus round trips | Right trade for a cache; needs coalescing (#4) and divergence detection (#6) to be complete |
| Fail-fast bounded startup; `/readyz` gates on hydration | A never-ready zombie is worse than a crash loop | Correct, well-reasoned, correctly wired to probes |
| Standalone fallback on partial config | "Fall back to well-understood behavior" | **Wrong default at `minReplicas: 2`** — see Top 10 #1; right instinct, wrong failure mode |

---

<a name="architectural-patterns"></a>
## Architectural Patterns

**Patterns identified (new in this pass):**
- **Multi-master replication with per-key origin serialization** — each node applies writes locally then broadcasts; per-key promise chains serialize same-node same-key publishes. No global ordering (events carry a `seq` that nothing consumes — either use it for LWW tie-breaking/dedup or drop it).
- **Read-local / write-through-async** — the in-memory store is a full hot replica; Cosmos is the cold source of truth touched only on writes and hydration.
- **Snapshot + buffered-replay hydration** — live events buffer during snapshot load and replay after, so mid-hydration writes beat the older snapshot. Textbook-correct and rare to see done right.
- **Heartbeat-based membership with staleness eviction** — `nodes` container + 30 s staleness window; view-only (nothing routes on membership), which keeps it low-risk.
- **Declarative side-effect registration** — `mutatedKeys`/`fieldReplication` on the command table; the dispatcher owns replication so handlers can't forget it.
- **Structural typing over optional SDKs** — local minimal interfaces for the Cosmos/Service Bus SDK surfaces, keeping them `optionalDependencies` without type casts; consistent with the OTel approach.

**Pattern effectiveness:**
- The **no-op-never-replicates** rule (checking key existence before *and* after) closing the phantom-delete hazard, and the **never-downgrade-to-whole-key-delete** rule for emptied hashes/zsets, are exactly the two subtleties naive implementations get wrong. Their presence — with explanatory comments — is strong evidence of design care.
- The **consistency documentation** in `docs/high-availability.md` is unusually honest about what's traded away, including the correct observation that no `EXISTS`/`TYPE` exposure makes empty-entry lingering client-invisible.
- **Pattern conflict (the one that matters):** whole-entry replication (`EXPIRE`/`PEXPIRE`, and any future command routed via `mutatedKeys` against hashes/zsets) conflicts with field-granular replication on the same keys — the absolute upsert clobbers what the granular path carefully preserved (Top 10 #2). The two replication grains need a rule: *container-typed entries never replicate whole-entry except on delete.*
- **Missing pattern:** anti-entropy. Every eventually-consistent multi-master system needs a convergence backstop for missed events; this one has none (Top 10 #6). Fire-and-forget + at-most-once delivery + 5-minute message TTL without repair means divergence is permanent until overwrite.
- **Alternative not taken:** delta/CRDT-style events for counters (Top 10 #5) — commutative increments would fix the flagship race cheaply; the current absolute-value events are the simplest correct-ish choice for everything else.

**Technical debt implications:** the HA layer *is* the new debt — high-quality, but ~1,500 lines of the most expensive kind of code to own (distributed, failure-mode-driven, Azure-semantics-coupled). The declarative structure and null-object standalone mode contain it well. The debt is priced acceptably **only if** the premise question (System Overview) resolves in HA's favor.

---

<a name="scalability"></a>
## Scalability Analysis

**Horizontal scaling assessment (3/5 — was 1/5 by design):**
- *Stateless vs stateful:* every node is a full stateful replica; any node serves any client; scale-out is real (Bicep: `minReplicas: 2`, `maxReplicas: 5`, TCP-connection-based autoscale rule at 200 concurrent connections — a sensible scale driver for a RESP service).
- *Limits:* capacity ceiling = one node's memory (full copy per node) and write fan-out cost scales with N (every write → N−1 deliveries + shared Cosmos write). Read throughput scales linearly; write throughput does not. This is the right shape for a read-heavy cache and an acceptable one for the target workload — but worth stating in the docs.
- *Data partitioning:* none (each node = full keyspace). Growth path remains namespace sharding (a second independent cluster per use case), unchanged.
- *Load balancing / discovery:* Container Apps TCP ingress, per-connection; heartbeat membership is observability-only. Adequate.
- *New scaling hazard:* hydration time grows with keyspace (and today, with all-time expired-key accumulation — Top 10 #3), directly extending scale-out latency: a new replica can't take traffic until `loadAll()` completes.

**Vertical scaling assessment (3/5):**
- *Bottlenecks (re-ranked):*
  1. **Replication overhead per write** — one Cosmos round trip + one Service Bus publish per mutating command (uncoalesced), plus apply cost on every peer. This is now the dominant per-write cost and the dominant *cost* cost (Top 10 #4).
  2. **O(keyspace) walks** — TTL sweep (5 s), metrics gauge (per scrape), and now heartbeat (10 s) — three independent full walks (Top 10 #8).
  3. **O(entry) accounting recompute** — on local *and* replicated hash/zset writes (Top 10 #8).
  4. **`PUBLISH` fan-out** — unchanged locally; cross-node adds one broadcast per publish (cheap) but total delivered messages scale with cluster-wide subscribers.
  5. Parser/backpressure paths — bounded since pass two; no longer material.
- *Memory:* unchanged (latin1 2× tax; `Buffer` refactor still the best capacity lever) — but now multiplied by N replicas, and hydration bypasses the ceiling (Top 10 #3).

**System bottlenecks — current → future:** the leading indicators are now *replication lag* and *Cosmos RU consumption*, and neither is measured. Add: replication publish latency histogram, in-flight replication gauge (`inFlight.size`), events-applied counter per node, and hydration duration/key-count (logged today, worth a metric). Without a lag signal, the eventual-consistency window is unobservable in production.

---

<a name="reliability"></a>
## Reliability Review

**Fault tolerance assessment (3/5 — single-node loss is now survivable, but new distributed failure modes arrived):**

| Failure | Behavior now | Assessment |
|---|---|---|
| Node restart / redeploy / scale-in | Peers keep serving; restarted node hydrates before taking traffic; clients reconnect | ✅ The headline win — genuinely delivered, with correct probe wiring |
| Full-cluster restart | State restored from Cosmos | ✅ New capability (was: total loss) |
| Cosmos down at startup | Fail-fast within `CLUSTER_STARTUP_TIMEOUT_MS` (30 s) → crash-loop with backoff | ✅ Correct choice, well-argued in docs |
| Cosmos/Service Bus down at runtime | Writes still succeed locally; replication fails with warn logs; cluster diverges | ⚠️ Acceptable *if bounded* — but there's no recovery path (Top 10 #6) |
| Node misses replication events (>5 min partition, subscription deleted, sustained receive errors) | Silent, permanent divergence until each key is next written | ❌ The biggest reliability gap (Top 10 #6) |
| Partial/missing HA config at 2+ replicas | Warn log, then N independent standalone nodes behind one LB | ❌ Split-brain by misconfiguration (Top 10 #1) |
| Concurrent cross-node writes, same key/field | Last-write-wins; counters undercount under contention | ⚠️ Documented; fixable for counters (Top 10 #5) |
| `EXPIRE` racing field writes | Whole-entry upsert reverts peers' unreplicated fields | ❌ Undocumented correctness bug (Top 10 #2) |
| Oversized Cosmos keyspace | Hydration bypasses memory ceiling → restart-loop OOM potential | ⚠️ Time bomb via expired-doc accumulation (Top 10 #3) |

- *Graceful shutdown:* drain of in-flight replication (bounded 2 s) before deregistering — thoughtful, including the heartbeat-resurrection edge case the comment calls out. The crash path (`uncaughtException` → full drain including `cluster.stop()`'s network calls) still has no hard exit timer (Top 10 #10).
- *Degradation strategy:* local-first writes mean the data plane degrades gracefully when Azure dependencies fail — correct for a cache. What's missing is *knowing* it happened: replication failures are warn logs with no counter, no lag metric, no alert surface.

**Disaster recovery capability (4/5 — was 2/5):**
- *RPO:* ≈ replication latency (sub-second typical) for anything persisted; whole-cluster loss recovers from Cosmos. A dramatic improvement — and past the point of what ephemeral data strictly needed, which is the premise question again.
- *RTO:* restart + hydration + probe pass; bounded by keyspace size (and today by expired-doc bloat — Top 10 #3).
- *Multi-region:* out of scope; Cosmos could carry it later if ever justified.
- *Contract drift risk (elevated):* now that data *does* survive restarts, the temptation to store durable business state in a fluent-Redis-speaker is much stronger, while the consistency model (LWW, no atomicity) is still wrong for it. The docs' closing paragraph ("if a workload needs stronger guarantees, it has outgrown this") is exactly right — keep it prominent.

**Reliability improvements:** Top 10 #1, #2, #3, #6 immediately; replication-lag observability (Scalability section); then the carried-forward floor (#10).

---

<a name="security"></a>
## Security Assessment

**Security measures evaluation:**
- *Unchanged strengths:* pre-auth command gating, timing-safe comparisons, anti-exfiltration admin design, no scripting anywhere (the docs correctly note even the Cosmos layer uses no stored procedures), loud startup warnings on unset secrets, internal-only ingress.
- *New surface — Service Bus:* connection string requires **Manage** rights (namespace-scoped), because nodes create/delete their own subscriptions. The replication topic is now effectively a write path into every node's memory: any principal that can Send can inject `upsert`/`delete`/`publish` events (no signing, no schema validation beyond field presence, `body as ReplicationEvent`). Within the intended trust boundary this is fine — but the boundary moved and `docs/security.md` hasn't fully caught up (Top 10 #7).
- *New surface — Cosmos:* Bicep uses the account connection string (account-key = full account access) even though the code already supports AAD via `COSMOS_ENDPOINT` + `DefaultAzureCredential`. Use the path the code already built (Top 10 #7).
- *Event validation:* `applyRemoteEvent` field-checks before applying and catches per-event errors — good — but a malformed entry snapshot (e.g. absurd sizes) is applied without bounds because replicated applies bypass admission control. Acceptable within the trust boundary; another reason to keep that boundary tight.

**Vulnerability analysis (ranked):**
1. Split-brain misconfiguration (Top 10 #1) — an availability/correctness failure with security-adjacent consequences (rate limits silently per-node ≈ fail-open).
2. Broad-privilege connection strings for both new dependencies (Top 10 #7).
3. Replication-topic injection surface — mitigated by network + RBAC scoping, worth documenting explicitly.
4. Carried forward: `AUTH` brute-force at line speed; unpinned base image; no dependency advisory scanning — now weightier with three `@azure/*` SDK trees in the runtime image (~1,100 lockfile lines added).

**Security recommendations:** Top 10 #1, #7, then the carried floor (#10). Update `docs/security.md` to add the Service Bus topic and Cosmos containers to the threat model — the current doc still describes a two-secret, single-process world.

---

<a name="cost"></a>
## Cost Efficiency

**Resource utilization assessment (2/5 — was 5/5; the thesis inverted):**
- *Compute:* ≥2 replicas (0.25 vCPU / 0.5 Gi each) ≈ $20–30/month — fine.
- *Service Bus:* topics require Standard tier ≈ $10/month base + per-operation charges; every mutation = 1 send + (N−1) receives.
- *Cosmos DB — the dominant term:* every mutating command is a document write (~10 RU upsert; patches somewhat less). At a modest sustained 100 mutating commands/s: ~1,000 RU/s ≈ 86 M RU/day ≈ **hundreds of dollars/month** serverless, or a provisioned-throughput commitment sized to peak write rate. For comparison, the managed Redis this system was built to avoid: ~$16/month (Basic C0) to ~$100/month (Standard C1) — *with* atomic `INCR` and strong single-node consistency. Unless write rates are very low or the durability requirement is hard, **the HA design costs more than the thing it replaces while providing weaker consistency.** This must be measured against real traffic before production (Top 10 #4).
- *Storage:* unbounded today (expired docs never deleted — Top 10 #3); native TTL makes it self-limiting and costs nothing.
- *Operational overhead:* the largest new cost is unpriced — owning a bespoke replication protocol across two Azure services. The test fence (fakes, hermetic standalone mode) contains regression risk well, but Azure-side behavior (subscription idle semantics, RU throttling, partition behavior) is outside the fence entirely.

**Cost optimization suggestions:**
- *Immediate:* write coalescing (Top 10 #4) — cuts the dominant cost on exactly the hot-counter workload; native TTL (Top 10 #3) — caps storage.
- *Structural:* consider persistence-exempting short-TTL keys (most rate-limit/sliding-window state) — Service-Bus-only replication for them preserves HA-for-restarts of *nodes* while avoiding per-increment RU on data that expires in seconds anyway. Full-cluster restart would reset those counters — which was the accepted contract for all data until this month.
- *Decision-level:* do the managed-Redis comparison honestly (price, consistency, code ownership) and record the outcome in `docs/high-availability.md`. Whichever way it lands, the reasoning should be as well-documented as the original single-replica reasoning was.

---

<a name="roadmap"></a>
## Implementation Roadmap

**Phase 1 — Immediate (this week): make the HA layer safe to operate.**
Top 10 #1 (fail-fast on partial config — hours, highest severity), #2 (TTL-only replication events), #3 (Cosmos native TTL + hydration filter), #4 (write coalescing + RU measurement), #5 (delta `INCR`). Roughly 2–3 focused days, all in code merged this week.

**Phase 2 — 3–6 months: distributed-systems operational maturity.**
- Divergence detection and recovery: fatal-on-dead-subscription, periodic incremental re-hydration (Top 10 #6).
- Replication observability: lag/latency histograms, in-flight gauge, applied-events counter, hydration metrics; alert rules.
- Managed identity + least privilege for Service Bus and Cosmos; threat-model update (Top 10 #7).
- Adversarial fake-transport modes and consistency-claim tests (Top 10 #9).
- The carried single-node floor: O(keyspace)/O(entry) hot paths, `AUTH` throttling, supply-chain pinning, bounded crash shutdown, runbook (Top 10 #8, #10).
- Load test: replication overhead per write, hydration time vs. keyspace size, autoscale behavior under connection churn; publish the measured envelope.

**Phase 3 — 6–12 months: evolve or consolidate.**
- Revisit the premise with production data: measured availability incidents prevented, measured RU spend, measured divergence events. Keep HA if the numbers justify it; if they don't, the standalone code path — still fully intact and hermetically tested — is the fallback the architecture deliberately preserved.
- If HA stays: `Buffer`-based values (now saves memory × N replicas), namespace sharding playbook per use case, possible delta-replication generalization (hash field writes are already effectively deltas).
- If durability stays: revisit which key classes deserve it (persistence-exempt TTL'd keys).

---

<a name="metrics"></a>
## Architecture Metrics

**Quantitative assessments** (second pass → now):

| Dimension | Score | Basis |
|---|---|---|
| Performance | **3/5** (was 4/5) | Local read/write path unchanged and fast; every write now carries async Cosmos+Service Bus work, three background O(keyspace) walks, and peer-apply overhead. Replication lag unmeasured. |
| Reliability | **3/5** (was 4/5 single-node) | Scored against the new, harder promise: node-loss survival genuinely delivered; offset by silent-divergence risk, the split-brain misconfiguration path, the EXPIRE clobber race, and the hydration time bomb. |
| Security | **3/5** (was 4/5) | Single-node floor intact; new broad-privilege secrets and an undocumented trust-boundary expansion regress the posture until Top 10 #7 lands. |
| Cost | **2/5** (was 5/5) | Two managed services + per-write RU on ephemeral data inverts the original thesis at moderate write rates; unmeasured. |
| Maintainability | **3/5** (was 4/5) | The new code is well-structured, well-commented, and well-tested for what fakes can cover — but it is 1,500 lines of distributed-systems logic coupled to Azure semantics, the most expensive category of code to own. |

**Qualitative assessments:**
- *Fitness for purpose:* **Conditional.** As an engineering artifact, the HA layer is executed with unusual care — the hydration buffering, no-op filtering, and field-granularity reasoning are better than most production systems manage. Whether it *fits the purpose* depends on the unanswered premise question: it delivers durability the data contract never required, at a cost structure that likely exceeds the managed alternative it was built to avoid, with weaker consistency on the flagship use case. Fitness is a decision away, in either direction.
- *Future-proofing:* **Good mechanically** — standalone mode is fully preserved and hermetically tested, so the pivot is reversible; limits and cluster config are env-driven; the declarative replication registry means new commands can't silently skip replication.
- *Technical debt:* prior passes' debt largely unaddressed (see status table) and now joined by the HA layer itself. The three highest-interest items are the split-brain fallback, the missing anti-entropy, and the unmeasured cost model.
- *Team capability alignment:* **the axis that moved most.** Passes one and two reviewed a system a competent TypeScript team could fully own. Multi-master replication over Service Bus + Cosmos demands distributed-systems failure-mode thinking and Azure-specific operational knowledge (RU governance, subscription idle semantics, receiveAndDelete loss modes) on an ongoing basis. The team that wrote it clearly has the skill; the question is whether owning it forever is the best use of that skill.
- *Innovation potential:* the declarative replication registry and the snapshot+buffered-replay hydration are patterns worth reusing. The honest consistency documentation is a practice worth institutionalizing.

**Bottom line.** The first review's theme was "an unbounded thing needs a bound" — resolved. The second's was "refine the bounds" — mostly still open. This pass's theme is different in kind: **a well-built answer needs its question validated.** The HA implementation is careful, honest about its trade-offs, and reversible by design. But it triples the operational surface, inverts the cost thesis, and weakens consistency on the system's primary use case — while five concrete defects (split-brain fallback, EXPIRE clobbering, unbounded Cosmos growth, uncoalesced hot-key writes, silent divergence) stand between the current code and production. Fix those five this week; answer the premise question before the first production deployment, and write the answer down with the same candor the rest of these docs already show.
