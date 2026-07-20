# BackendCache — Comprehensive Architectural Review (Fourth Pass: Cost, on a Committed Architecture)

**Date:** 2026-07-20 (fourth pass)
**Scope:** Full repository at commit `7e0b767` — source, tests, Dockerfile, Bicep infra, and docs.
**Context:** Since the third pass (at `3f40031`), PR #10 landed fixes for **every third-pass finding**: the five pre-production HA defects, G-counter `INCR` replication, anti-entropy, managed-identity auth, and the carried-over hardening floor (~1,900 lines including tests). Separately, the review's framing has changed on direction from the owner: **managed Redis is not an alternative** — it has failed to deploy 20+ times in this Azure environment, and the Cosmos DB + Service Bus HA architecture is the committed approach. The third pass's "premise question" is therefore answered and closed. This pass verifies PR #10's fixes and re-runs the review with the cost lens re-anchored accordingly: not "should this exist," but **"how do we make this exact architecture as cheap as possible to run"** — while keeping the other lenses current.
**Verification:** typecheck clean, **183/183 tests passing** at head (including the new `adversarialReplication`, `authThrottle`, and `clusterFactory` suites and the expanded coordinator/store/dispatcher tests).

> **Decision record (recommend committing this to the repo, e.g. in `docs/high-availability.md`):** *Azure Cache for Redis was evaluated and rejected as the cross-replica backend after 20+ failed deployment attempts in this environment. BackendCache's Cosmos DB + Service Bus HA design is the committed architecture; future reviews optimize within it rather than relitigating it.* The earlier passes asked for exactly this kind of documented decision; it now exists — it should live in the repo, not in a chat thread.

---

## Verification of the Third-Pass Top 10

| # | Third-pass finding | Status | Verification notes |
|---|---|---|---|
| 1 | Silent standalone fallback at 2+ replicas (split-brain) | ✅ **Fixed** | `REQUIRE_HA=true` (set in the Bicep) makes partial/missing HA config a hard startup failure with a precise error message; strict boolean parsing; covered by `clusterFactory` tests. |
| 2 | `EXPIRE`/`PEXPIRE` whole-entry replication clobbering peers | ✅ **Fixed** | New `ttl` event kind + `Store.applyReplicatedTtl` + Cosmos patch of `/entry/expiresAtMs` and native `ttl` only. Docs updated with the exact race this closes. |
| 3 | Expired docs never deleted from Cosmos; unbounded hydration | ✅ **Fixed** | Per-document native `ttl` derived from `expiresAtMs` on every upsert; hydration query filters expired docs server-side; coordinator re-checks client-side; hydration is now also **bounded by `maxMemoryBytes`** (partial load + loud `cluster.hydration_truncated` warning instead of an OOM restart loop). |
| 4 | Uncoalesced per-key replication writes | ✅ **Fixed** (with headroom) | Per-key FIFO with coalescing classes: consecutive `whole` writes collapse to the latest, as do `ttl` and `incr`; classes never reorder across each other. A burst of N `INCR`s ≈ 1 in-flight + 1 coalesced write. **Headroom:** `field` events never coalesce — see new Top 10 #4. |
| 5 | `INCR` last-write-wins undercounting | ✅ **Fixed — better than asked** | Full G-counter: per-origin cumulative contributions, merged by max on peers and in Cosmos (per-origin patch), seed origin for `SET`-created bases, safe-integer rollback, counter-vs-plain-string merge semantics documented (`SET` deliberately resets). Reordered/duplicated/delayed delivery provably can't drift the sum — and the adversarial suite tests exactly that. |
| 6 | Silent replication death / no anti-entropy | ✅ **Fixed** | Transport counts consecutive receive errors (10 → fatal), detects entity-gone immediately, and signals `onFatalReplicationError` → bounded shutdown → restart re-creates the subscription and re-hydrates. Plus periodic anti-entropy (`ANTI_ENTROPY_INTERVAL_MS`, default = the 5-min message TTL) re-loads durable keys changed since the last watermark. |
| 7 | Broad-privilege connection strings | ✅ **Fixed** | Managed identity (DefaultAzureCredential) for both Service Bus (`SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE`) and Cosmos; Bicep drops both secrets entirely and pins `AZURE_CLIENT_ID`; connection strings remain only as a local/dev fallback. `docs/security.md` updated with the trust-boundary expansion. |
| 8 | O(keyspace)/O(entry) hot paths | ✅ **Mostly fixed** | Heartbeat now reads O(1) `keyCounts()`; the metrics gauge reads O(1) `memoryBytesEstimate()`. **Remaining:** the O(entry-size) accounting recompute on hash/zset writes, and `src/index.ts:52` still binds the telemetry key-count source to `store.stats()` (a full walk per scrape) instead of the new O(1) `keyCounts()`. |
| 9 | Untested consistency claims | ✅ **Fixed** | `fakeCluster` gained delay/reorder/drop/duplicate modes; `adversarialReplication.test.ts` exercises the documented invariants including G-counter convergence under hostile delivery. |
| 10 | Carried operational floor | ✅ **Largely fixed** | `AUTH` throttling (`MAX_FAILED_AUTH_ATTEMPTS`, default 5, tested); `npm audit` CI job (non-blocking with a documented reason); base image pinned to a patch tag with a digest-pinning path documented; hard shutdown timer (`SHUTDOWN_HARD_LIMIT_MS`, 10 s) covering `cluster.stop()`'s network calls. **Still open:** slow-command log, admin-port reachability runbook, load-test-derived sizing. |

**Net effect:** the third pass's five pre-production defects are all closed, with test coverage, and two of the fixes (G-counter, anti-entropy) came back stronger than the recommendation. The architecture is now in genuinely deployable shape. What remains is the subject of this pass: **running it cheaply.**

---

## Top 10 Changes to Make Today (Fourth Pass — Cost-Focused)

Cosmos RU consumption is the dominant marginal cost of this architecture; Service Bus operations and replica compute are secondary. These are ordered by expected $ saved per hour of effort. Items 1–4 attack RU directly; 5–6 make cost measurable and buyable correctly; 7–9 trim steady-state overhead; 10 closes the loop.

| # | Change | Why | Where |
|---|--------|-----|-------|
| 1 | **Set a custom indexing policy on the `keys` container.** Cosmos's default policy indexes *every path in every document* — every field name of every presence hash, every member of every sliding-window zset, every counter origin. Write RU scales with indexed paths, so hash/zset patches and upserts pay to index data that is never queried. The only paths queries touch are `/key`, `/updatedAtMs`, and `/entry/expiresAtMs`. Exclude `/*`, include those three. Typically a **2–5× write-RU reduction** on container-typed entries; zero code changes; applies immediately to new writes. | The single biggest RU lever available, and it's pure infra config | Cosmos container config; document in `infra/backendcache.bicep` + `docs/deployment.md` |
| 2 | **Make short-TTL keys Service-Bus-only (`DURABILITY_MIN_TTL_MS`).** The highest-write-rate keys — fixed-window rate-limit counters, sliding-window zsets — live seconds to a minute and would expire before a restart could care about them. At publish time, skip the durable write for any key whose remaining TTL is under a threshold (default e.g. 60 s): peers still converge via Service Bus (they don't read Cosmos for live replication), hydration/anti-entropy simply won't see keys that would be dead anyway. Trade-off: a *full-cluster* restart loses sub-threshold keys — which was the accepted contract for **all** data until this month. This removes the dominant RU source outright rather than optimizing it. | Rate-limit churn is most of the write volume and the least durability-worthy | `src/cluster/clusterCoordinator.ts`, `src/config.ts`, `docs/high-availability.md` |
| 3 | **Decouple the Cosmos cadence from the Service Bus cadence.** Peers need SB events at full speed (they drive convergence); the durable store's only consumers are restarts and anti-entropy, which tolerate bounded staleness. Add a per-key minimum interval between durable writes (`DURABLE_WRITE_MIN_INTERVAL_MS`, e.g. 1000 ms) for the `whole`/`incr` coalescing classes: the queue mechanics already exist, this adds a time gate, so a hot counter costs ~1 RU-write/second instead of one per round-trip-latency. SB broadcasts stay per-coalesced-batch. | Coalescing bounded writes by *latency*; this bounds them by *policy* | `src/cluster/clusterCoordinator.ts`, `src/config.ts` |
| 4 | **Extend coalescing to `field`-class events.** Consecutive queued `HSET`/`HDEL` (and `ZADD`/`ZREMRANGEBYSCORE`) tasks for the same key currently never merge, but they compose cleanly: later set-value per field wins, sets and deletes fold into one net patch + one event. High-churn presence hashes (the same `user:<id>` field flapping online/offline) currently pay one Cosmos patch + one SB message per flap. | Same win #4 in the third pass delivered for counters, now for presence | `src/cluster/clusterCoordinator.ts` (`ReplicationTask` merge for `'field'`) |
| 5 | **Meter what you spend: capture Cosmos `requestCharge` and SB operation counts.** Every Cosmos SDK response carries the RU charge of that call; today it's discarded (the structural interfaces don't expose it — add one field). Emit `backendcache.cosmos.request_units` (counter, dimensioned by operation: upsert/patch/query/delete) plus an SB publish counter, replication-queue depth gauge, and replication-lag histogram. This turns the capacity-mode decision (#6) and the thresholds in #2/#3 into arithmetic on a week of real data instead of guesses. | You can't optimize — or budget — what you don't measure | `src/cluster/cosmosDurableStore.ts`, `src/telemetry/` |
| 6 | **Choose the Cosmos capacity mode from #5's data and set a spend alarm.** Rule of thumb: serverless wins at low/bursty sustained RU; autoscale provisioned throughput wins once sustained average RU/s clears a few hundred (autoscale bills for the high-water decile, serverless per request). After one representative week: pick, document the reasoning in `docs/deployment.md`, and add an alert on RU consumption slope so a keyspace or traffic regression shows up as a cost signal, not a bill. | The same workload can differ several-fold in bill purely by capacity mode | Cosmos account config, `docs/deployment.md`, alert rules |
| 7 | **Trim the heartbeat document and TTL the `nodes` container.** Each node upserts its full pub/sub topology (every channel and pattern name) every 10 s — document size, and therefore RU, grows with Socket.IO room count, and it's re-paid 6×/minute/node forever. Cap it (counts + top-N channels), and set a native `ttl` (~2× `NODE_STALE_MS`) on node snapshots so a crashed node's document self-cleans instead of lingering (graceful `deleteNodeSnapshot` doesn't run on a crash). | Steady-state background RU that scales with rooms × nodes × uptime | `src/cluster/clusterCoordinator.ts` (`heartbeat()`), `src/cluster/cosmosDurableStore.ts` |
| 8 | **Anchor anti-entropy on Cosmos `_ts` instead of client `updatedAtMs`.** The watermark currently mixes writer clocks (each node stamps `updatedAtMs` locally) with the reconciling node's own clock for the initial value — cross-node skew can make a pass miss writes landed by a slow-clocked peer. Cosmos assigns `_ts` (server epoch-seconds) on every write, it's always index-covered, and it's free. Query `WHERE c._ts > @since` and carry the max `_ts` as the watermark. Also skip #2's persistence-exempt keys in the reconcile query once that lands. | Removes a subtle correctness hole in the backstop *and* keeps the query cheap | `src/cluster/cosmosDurableStore.ts` (`loadChangedSince`), `src/cluster/clusterCoordinator.ts` |
| 9 | **Counter-origin hygiene + the last O(n) telemetry walk.** Container Apps replica names change every revision, so a long-lived counter accrues one dead origin entry per deploy generation (in memory, in every event, and in its Cosmos doc). TTL'd counters don't care; for persistent counters, compact origins absent from the live-node set into the seed during hydration (safe: a gone node's contribution is final). And swap `src/index.ts:52`'s `bindKeyCountsSource(() => store.stats())` to the O(1) `keyCounts()` — the walk it does per metric scrape is exactly what PR #10 built the counters to avoid. | Bounds per-counter growth across deploys; finishes the O(1) observability work | `src/store/store.ts`, `src/cluster/clusterCoordinator.ts`, `src/index.ts:52` |
| 10 | **Load-test with the meters on, then right-size everything.** With #5 in place, run a representative Socket.IO + rate-limit load and derive: RU per command class (validates #1–#4's savings), replication lag under burst, node CPU/memory headroom (informs whether the O(entry) accounting recompute — still open — actually matters at your entry sizes), replica count/size, and the numeric defaults for `DURABILITY_MIN_TTL_MS` / `DURABLE_WRITE_MIN_INTERVAL_MS`. Publish the measured envelope + a cost model table in `docs/deployment.md`. | Converts every guessed number in this architecture into a measured one | load harness, `docs/deployment.md` |

Also carried (non-cost): slow-command log, admin-port reachability runbook — unchanged from prior passes, still worth an afternoon.

Everything below is the full re-assessed analysis.

---

<a name="system-overview"></a>
## System Overview

**Core business purpose.** A drop-in RESP2-compatible cache/pub-sub service for cross-replica rate limiting, presence, Socket.IO fan-out, and abuse guards — now durable and highly available across 2+ replicas via Service Bus replication and Cosmos DB persistence. **The architecture is committed**: managed Redis failed 20+ deployment attempts in this Azure environment and is off the table. The engineering question is execution quality and run-cost, both of which this pass finds in good and improving shape.

**System boundaries and interfaces:** unchanged from the third pass (RESP `:6379`, `/healthz` + `/readyz`, cluster-aware `/admin/*`, Service Bus topic, Cosmos `keys`/`nodes` containers, OTLP egress) — except the Azure dependencies now authenticate via **managed identity** with no stored secrets, which also simplifies the interface inventory: two Key Vault secrets total (RESP password, admin token).

**What changed in the replication design since the third pass (all verified):**
- **Event taxonomy is now complete and shape-correct:** whole-key (`SET`/`DEL`), cumulative-contribution (`INCR`, G-counter), field/member deltas (`HSET`/`HDEL`/`ZADD`/`ZREMRANGEBYSCORE`), TTL-only (`EXPIRE`/`PEXPIRE`), and ephemeral (`PUBLISH`). Each shape replicates the minimum superseding fact, which is both the correctness fix and the cost foundation.
- **Coalescing classes** collapse redundant queued writes per key without reordering across classes.
- **Convergence is defended in depth:** live events (fast path) → anti-entropy re-hydration every 5 min (backstop for missed events) → fatal-error restart (backstop for a dead receiver) → bounded hydration (backstop for an oversized keyspace).
- **The G-counter is the standout:** per-origin cumulative totals merged by max are commutative and idempotent, so the flagship use case (shared rate-limit counters) now *cannot* undercount from reordered, duplicated, or delayed delivery — verified by adversarial tests. `SET`-resets and seed-origin promotion are handled and documented.

**Key architectural decisions and drivers** (delta view):

| Decision | Driver | Assessment |
|---|---|---|
| Commit to Cosmos+Service Bus HA; reject managed Redis | 20+ failed Redis deployments in this environment | Decision made with operational evidence; record it in-repo (see decision-record note above) |
| Per-shape replication events with coalescing classes | Correctness first, cost second | Right structure; its natural completion is items #2–#4 above |
| G-counter for `INCR` | Rate limiting must not fail open under contention | Correct CRDT choice; conflict-free where it matters, LWW where that's honest |
| Anti-entropy defaulted to the SB message TTL | A partition longer than message retention must self-heal | Right coupling of the two constants; move to `_ts` (#8) |
| Managed identity everywhere | Blast-radius reduction | Done properly, including `AZURE_CLIENT_ID` pinning |
| `REQUIRE_HA` in the multi-replica deployment | Split-brain must be impossible by construction | The invariant is back — enforced by config instead of replica count |

---

<a name="architectural-patterns"></a>
## Architectural Patterns

**New/matured patterns this pass:**
- **CRDT-style convergent counter (G-counter)** — per-origin monotone totals, max-merge, seed origin for LWW interop with `SET`. Textbook, correctly scoped to the one command whose semantics are additive.
- **Coalescing write-behind queue** — per-key FIFO with supersession classes; the standard pattern for fan-in replication cost control, implemented with correct ordering guarantees.
- **Anti-entropy reconciliation** — watermark-based incremental re-sync; the missing half of every gossip/fan-out design, now present. (Watermark source should move to server time — #8.)
- **Fail-fast invariant enforcement** — `REQUIRE_HA` converts an operational assumption into a startup precondition. This, plus the earlier "declarative replication registry," shows a healthy pattern habit: making wrong states unrepresentable rather than documented-against.
- **Adversarial test doubles** — the fake transport's delay/reorder/drop/duplicate modes turn documented consistency claims into executable properties. This is the practice that keeps a bespoke replication protocol ownable long-term.

**Pattern effectiveness:** no conflicts found this pass. The one structural gap is that the coalescing pattern stops short of the `field` class (#4) and has no time dimension (#3) — both are natural extensions of machinery that already exists, not new designs.

**Technical debt:** the third pass called the HA layer "well-built debt whose premise needed validating." The premise is now validated by operational reality (Redis unde­ployable here), and the layer gained the two things that most reduce its carrying cost: adversarial tests and honest failure-mode docs. Remaining debt is small and enumerated: O(entry) accounting recompute, `index.ts:52` stats walk, field-coalescing, the runbook.

---

<a name="scalability"></a>
## Scalability Analysis

**Horizontal scaling assessment (3/5, unchanged):** 2–5 replicas, connection-based autoscale, every node a full copy. Ceiling remains one node's memory; write cost scales with N (each write → N−1 SB deliveries + shared Cosmos writes). Fine for the target workload; the growth path remains namespace sharding into a second independent cluster. Hydration now filters expired docs and is memory-bounded, so scale-out latency is bounded by *live* keyspace size — a real improvement to elasticity.

**Vertical scaling assessment (4/5, up from 3/5):**
- Fixed since last pass: heartbeat and metrics no longer walk the keyspace; hydration no longer loads dead keys.
- Remaining, in order: (1) replication RU/ops per write — now the cost story more than the performance one (Top 10 #1–#4); (2) O(entry-size) accounting recompute on hash/zset mutations, local and replicated — measure at your real entry sizes in #10 before deciding it matters; (3) `PUBLISH` fan-out — unchanged, still the eventual local ceiling; (4) `index.ts:52` per-scrape stats walk (#9).
- New observability need: replication-queue depth and lag (part of #5) — the queue is the new place where pressure accumulates invisibly.

**Bottleneck trajectory:** with the fixes in, the first production wall is most likely **Cosmos RU spend, not node performance** — which is exactly why this pass's Top 10 is a cost list.

---

<a name="reliability"></a>
## Reliability Review

**Fault tolerance assessment (4/5, up from 3/5):**

| Failure | Behavior now | Assessment |
|---|---|---|
| Node restart / redeploy / scale event | Peers serve; node re-hydrates (expired-filtered, memory-bounded) before readiness | ✅ |
| Full-cluster restart | State restored from Cosmos (minus native-TTL-evicted dead keys — correct) | ✅ |
| Missed replication events (partition, blip) | Anti-entropy pass repairs within ~5 min | ✅ Was the biggest gap; closed |
| Dead subscription / sustained receive errors | Fatal signal → bounded shutdown (10 s hard limit) → restart recreates + rehydrates | ✅ Closed |
| Partial/missing HA config | Hard startup failure under `REQUIRE_HA` (set in Bicep) | ✅ Closed |
| Cross-node concurrent `INCR` | Converges on the true sum (G-counter), adversarially tested | ✅ Closed — flagship use case now conflict-free |
| `EXPIRE` racing field writes | TTL-only event; cannot clobber | ✅ Closed |
| Oversized durable keyspace | Partial hydration + loud warning instead of OOM crash-loop | ✅ Closed (monitor the warning) |
| Remaining LWW races (`SET` vs `INCR`, same-field `HSET`) | Documented, honest, appropriate to a cache | ⚠️ Accepted by design |

**Disaster recovery (4/5, unchanged):** RPO ≈ replication latency for persisted keys; note that adopting Top 10 #2 (persistence-exempt short-TTL keys) *deliberately* trades RPO on sub-minute keys for RU — the right trade, worth stating in the HA doc when it lands. RTO = restart + bounded hydration.

**Remaining reliability work:** replication lag/queue metrics with alert rules (#5), the runbook (carried), and turning the `npm audit` job blocking once the transitive OTel advisory clears (the non-blocking rationale is documented in CI — good hygiene; set a reminder to revisit).

---

<a name="security"></a>
## Security Assessment

**Security posture (4/5, up from 3/5):**
- **Managed identity for both Azure dependencies** — the two broad secrets (namespace-Manage SAS, Cosmos account key) are gone from the deployment entirely; RBAC scopes the identity to the topic and the Cosmos data plane; `AZURE_CLIENT_ID` pinning avoids multi-identity ambiguity. This was the pass's biggest security ask, delivered cleanly. Connection strings remain as a dev/local fallback, clearly labeled.
- **`AUTH` brute-force throttling** — per-connection failed-attempt cap (default 5) forces a TCP reconnect per guess burst; tested.
- **Supply chain** — base image pinned to a patch tag (digest path documented), `npm audit` in CI (non-blocking with a written, reviewable reason), lockfile-only installs.
- **Trust boundary** — `docs/security.md` now covers the Service Bus topic and Cosmos containers as data-plane surfaces.
- **Remaining:** replication events are still applied structurally unvalidated (schema-light `body as ReplicationEvent`) — acceptable inside the RBAC-scoped boundary, but a cheap zod-style shape check on `applyRemoteEvent` would harden against a compromised or buggy publisher; the audit job should eventually block; the admin runbook remains open.

---

<a name="cost"></a>
## Cost Efficiency

**Reframing.** Prior passes scored cost partly against a managed-Redis baseline. That baseline is void here — 20+ failed deployments make it operationally unavailable, whatever its sticker price. Cost is therefore scored as: *how close is this implementation to the cheapest correct version of itself?*

**Resource utilization assessment (3/5 — up from 2/5, with a clear path to 4–5/5):**

**What the bill is made of, and what's already been done:**

| Cost component | Driver | State |
|---|---|---|
| Cosmos writes (dominant) | 1 write per mutating command, per key | ✅ Coalescing collapses hot-key bursts; ✅ patches ship only touched fields; ⬜ default indexing multiplies every write's RU (#1); ⬜ short-TTL keys still persisted (#2); ⬜ cadence latency-bound, not policy-bound (#3); ⬜ field events uncoalesced (#4) |
| Cosmos storage | Keyspace size over time | ✅ Native TTL evicts dead keys — growth is now self-limiting |
| Cosmos reads | Hydration, anti-entropy (5 min), admin views, heartbeat-driven queries | ✅ Hydration filtered/bounded; ⬜ anti-entropy should ride `_ts` (#8); ⬜ heartbeat payload grows with rooms (#7) |
| Service Bus | Standard-tier base (~$10/mo) + per-operation | ✅ Coalescing cuts ops; per-op cost is cents-per-million — secondary |
| Compute | 2–5 × (0.25 vCPU / 0.5 Gi) | ≈ $20–75/mo; connection-based autoscale is a sane driver |
| The unmeasured term | RU per command class | ⬜ `requestCharge` discarded today (#5) — the whole model is currently estimated, not observed |

**The strategy in one line:** *stop persisting what expires anyway (#2), stop indexing what's never queried (#1), write durably on a clock instead of a latency (#3), merge what supersedes (#4) — and meter it all (#5) so the capacity mode (#6) is bought, not guessed.*

**Order-of-magnitude effect (to be validated by #5/#10):** for a rate-limit-heavy workload, #2 alone can remove the majority of durable writes; #1 cuts the RU of each remaining container-typed write several-fold; #3/#4 flatten hot-key and presence churn. Together they plausibly take the Cosmos line from "dominant, scales with traffic" to "modest, scales with *durable* data" — which is the correct shape for this architecture, since Service Bus (cheap) carries the real-time load and Cosmos (metered) should carry only what genuinely needs to survive a full restart.

**Operational overhead:** the carrying cost of owning the replication layer dropped meaningfully this pass — adversarial tests, honest docs, fail-fast invariants, and no secrets to rotate. That cost was the third pass's biggest concern; it has been actively managed down.

---

<a name="roadmap"></a>
## Implementation Roadmap

**Phase 1 — Immediate (this week): the cost package.**
Top 10 #1 (indexing policy — infra config, biggest single lever), #5 (RU metering — makes everything else measurable), #9's one-liner (`index.ts:52`), then #2 and #3 (persistence exemption + durable-write cadence — the structural RU winners), #4 (field coalescing). Commit the decision record. Roughly 2–3 focused days.

**Phase 2 — 3–6 months: measured operation.**
- #6 capacity-mode selection + RU spend alarm from a week of #5 data.
- #10 load test; publish the measured envelope and cost model; right-size replicas and limits; decide whether the O(entry) accounting recompute matters at real entry sizes.
- #7 heartbeat trim + nodes-container TTL; #8 `_ts` watermark.
- Carried floor: slow-command log, admin runbook (including "is replication flowing" diagnostics), schema check on `applyRemoteEvent`, flip `npm audit` to blocking when the transitive tree clears.

**Phase 3 — 6–12 months: capacity evolution.**
- `Buffer`-based values (memory × N replicas is now the binding capacity resource).
- Namespace-sharding playbook (second independent cluster per use case) as the documented answer to outgrowing one node's memory.
- Counter-origin compaction if long-lived counters become a real pattern (#9).
- Revisit `PUBLISH` fan-out only if Socket.IO room scale demands it.

---

<a name="metrics"></a>
## Architecture Metrics

**Quantitative assessments** (third pass → now):

| Dimension | Score | Basis |
|---|---|---|
| Performance | **4/5** (was 3/5) | O(keyspace) background walks eliminated from heartbeat/gauge; hydration bounded and filtered; remaining items (O(entry) accounting, fan-out) are known and measured-before-fixed. |
| Reliability | **4/5** (was 3/5) | All five pre-production defects closed with tests; convergence defended at three layers (events → anti-entropy → restart); split-brain impossible by construction; remaining LWW races are documented design choices. |
| Security | **4/5** (was 3/5) | Managed identity everywhere, zero broad secrets, auth throttling, supply-chain scanning, updated threat model. Remaining: event schema validation, blocking audit, runbook. |
| Cost | **3/5** (was 2/5, reframed) | Scored against the committed architecture's own optimum: coalescing + native TTL landed; the five structural levers (#1–#4, #7) and the metering (#5) that proves them are identified, cheap, and unstarted. |
| Maintainability | **4/5** (was 3/5) | The distributed layer is now adversarially tested, its invariants are executable, its failure modes documented, and its config surface fully described. Owning it is a real ongoing cost, but a managed one. |

**Qualitative assessments:**
- *Fitness for purpose:* **High, and now unconditional.** The third pass's conditionality hinged on an alternative that turned out not to exist operationally. Within the committed architecture, the implementation is correct where it must be (G-counter, TTL events, anti-entropy) and honest where it chooses not to be (LWW on overwrites).
- *Future-proofing:* the per-shape event taxonomy is the asset — every cost lever in this pass's Top 10 slots into machinery that already exists (a class here, a time gate there, a query predicate there). No redesign is required to reach the cheap version of this system.
- *Technical debt:* enumerated and small; the pattern across four passes — findings raised, findings fixed with tests, stronger than asked — is the healthiest debt-management signal a codebase can show.
- *Team capability alignment:* the adversarial test suite materially de-risks ownership of the replication protocol; the remaining skill dependency is Azure cost mechanics (RU accounting, indexing policy, capacity modes), which is exactly what #5/#6 turn from expertise into dashboards.
- *Innovation potential:* the G-counter-with-seed-origin interop and the coalescing-class queue are both reusable designs; the "documented consistency claim → adversarial test" discipline is worth adopting as a standing rule for any future replication change.

**Bottom line.** Pass one: bound the unbounded — done. Pass two: refine the bounds — done (eventually). Pass three: five defects and a premise question — the defects are fixed with tests, and the premise is settled by operational reality: **this is the architecture.** What remains is the most tractable problem this review has had in four passes: a metered, five-lever cost-reduction program (index policy, persistence exemption, write cadence, field coalescing, RU telemetry) that requires no redesign, no new services, and no consistency trade the data contract hasn't already accepted. Run the Phase 1 package, read the meters for a week, buy the right capacity mode — and this system will be both the thing managed Redis couldn't be here (deployable) and the thing it was originally promised to be (cheap).
