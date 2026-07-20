# BackendCache — Comprehensive Architectural Review (Fifth Pass: Convergence)

**Date:** 2026-07-20 (fifth pass)
**Scope:** Full repository at commit `d110029` — source, tests, Dockerfile, Bicep infra, and docs.
**Context:** Since the fourth pass (at `7e0b767`), PR #12 delivered nearly the entire cost package: short-TTL persistence exemption, field-event coalescing, RU/ops/queue-depth metering, heartbeat trimming with nodes-container TTL, `_ts`-anchored anti-entropy, the O(1) telemetry fix, the indexing-policy and capacity-mode documentation, and the **in-repo architecture decision record** for why managed Redis is not an option here (20+ failed deployments). This pass verifies that work, reports two new findings in the fresh code, and — for the first time in five passes — finds the backlog *converging*: what remains is mostly switches to flip and measurements to take, not systems to build.
**Verification:** typecheck clean, **190/190 tests passing** at head (including the new `durabilityExemption` suite and expanded coordinator/dispatcher coverage).

---

## Verification of the Fourth-Pass Top 10

| # | Fourth-pass item | Status | Notes |
|---|---|---|---|
| 1 | Custom indexing policy on `keys` container | 📘 **Documented, not yet applied** | `docs/deployment.md` now carries the exact policy JSON and rationale. The container config change itself is an infra action outside this repo — it still has to actually be applied, and the new RU meters will prove it worked. |
| 2 | Short-TTL persistence exemption | ✅ **Built — but OFF** | `DURABILITY_MIN_TTL_MS` implemented across all replication paths (whole-key, incr, field, TTL), with deletes deliberately kept durable and a dedicated test suite. **Defaults to `0` (disabled) and is not set in the Bicep** — the flagship saving is currently a switch nobody has flipped (new Top 10 #1). |
| 3 | Durable-write time gate (`DURABLE_WRITE_MIN_INTERVAL_MS`) | ⬜ **Not implemented** | Reasonable sequencing: the exemption (#2) removes most of what the time gate would have throttled (hot counters are short-TTL), and the RU meters now exist to prove whether the remainder justifies it. Decide with data (new Top 10 #4). |
| 4 | Field-event coalescing | ✅ **Fixed** | Queued same-key field tasks merge into one net payload (later set/delete per name wins, in-place accumulator, never merges into an in-flight task). Presence flapping now costs one patch + one event per drain. |
| 5 | RU / ops / lag metering | ✅ **Fixed** | New `clusterMetrics.ts`: `backendcache.cosmos.request_units` (by operation), Service Bus publish counter, replication-queue depth gauge wired from `index.ts`. `requestCharge` is captured from Cosmos responses. The cost model is now observable. |
| 6 | Capacity-mode selection + spend alarm | 📘 **Documented, needs data** | Serverless-vs-autoscale guidance with break-even reasoning is in `docs/deployment.md`; the actual selection and alert rule await a week of #5's data (new Top 10 #5). |
| 7 | Heartbeat trim + nodes-container TTL | ✅ **Fixed** | Topology detail capped at top-25 by subscriber count (exact totals kept), heartbeat docs TTL'd at 2× the staleness window so crashed nodes self-clean. |
| 8 | Anti-entropy on Cosmos `_ts` | ✅ **Fixed** | Watermark now rides server-assigned `_ts`; client-clock skew can no longer cause missed writes. |
| 9 | Counter-origin hygiene + last O(n) walk | ◐ **Half done** | `index.ts` now binds the O(1) `keyCounts()` (walk eliminated). Counter-origin compaction across deploy generations was not done — genuinely low priority while counters are TTL'd (new Top 10 #7). |
| 10 | Metered load test | ⬜ **Not done** | Now unblocked by #5. The one remaining piece of real work in the backlog (new Top 10 #3). |
| — | Decision record | ✅ **Committed** | `docs/high-availability.md` opens with the ADR: managed Redis rejected on operational evidence; this architecture is the committed direction. Exactly what four passes of reviews asked for. |

**Two new findings in the fresh code** (both small, both in the exemption logic's edges):

- **F1 — A TTL-shortening `EXPIRE` can let the durable copy outlive the real key.** `doPublishTtlChange` skips the Cosmos patch when the *new* TTL is below the threshold. If the key was previously durable with a longer TTL, the Cosmos document keeps the *old* expiry: a node restarting (hydration) — or, if anything else touches the doc, anti-entropy — can resurrect a key for longer than any live node believes it should exist. A rate-limit reset via `PEXPIRE`-shorten is exactly this shape. Fix: when shortening below the threshold, still persist the TTL patch (it's one cheap patch on a rare transition) — or delete the document outright. Skipping is only safe when the key was *already* exempt.
- **F2 — The exemption checks TTL per-path but not at drain time consistently.** Whole-key/field paths read the entry's TTL at drain time (correct), but a coalesced task enqueued while the key was durable and drained after an `EXPIRE` shortened it (or vice versa) can straddle the threshold. The window is one queue drain — cosmetic in practice, but worth a comment or a re-check in `doPublishKeyChange` for symmetry with F1's fix.

---

## Top 10 Changes to Make Today (Fifth Pass)

The list has changed character: items 1–2 are configuration flips, 3–5 are measurements, and only 6–10 are code — all small. This is what a converging backlog looks like.

| # | Change | Why | Where |
|---|--------|-----|-------|
| 1 | **Turn the exemption on: set `DURABILITY_MIN_TTL_MS=60000` in the Bicep.** The dominant-RU-source removal was built and tested in PR #12 but defaults to `0` and isn't set in the deployment — as deployed, every rate-limit tick still writes Cosmos. One env line. | The biggest cost lever is currently installed but switched off | `infra/backendcache.bicep`, `docs/deployment.md` |
| 2 | **Apply the documented indexing policy to the real `keys` container.** The policy JSON is written and explained in `docs/deployment.md`; the container is presumably still on the default policy, paying to index every hash field and zset member on every write. Apply it, then watch `backendcache.cosmos.request_units` drop per-operation to confirm. | 2–5× write-RU reduction, already fully specified | Cosmos container config (infra action) |
| 3 | **Run the metered load test.** Representative Socket.IO + rate-limit load with the new meters on: RU per operation class (before/after #1–#2), replication lag and queue depth under burst, node CPU/memory headroom. Publish the envelope in `docs/deployment.md`. Every remaining sizing decision hangs off this. | The meters exist; the numbers don't yet | load harness, `docs/deployment.md` |
| 4 | **Decide the durable-write time gate with #3's data.** With short-TTL keys exempt, the remaining Cosmos writers are durable (no-TTL / long-TTL) keys — possibly low-volume enough that `DURABLE_WRITE_MIN_INTERVAL_MS` isn't worth its complexity. Implement only if the meters say the residual write rate matters. | Don't build a throttle for traffic that may no longer exist | decision first; `src/cluster/clusterCoordinator.ts` if warranted |
| 5 | **Pick the Cosmos capacity mode and set the RU spend alarm.** After a week of #3/#5 data: serverless vs autoscale per the documented break-even, plus an alert on RU-consumption slope so cost regressions surface as signals, not bills. | The last unbought decision in the cost program | Cosmos account config, alert rules |
| 6 | **Fix F1 (TTL-shorten must not strand a longer-lived durable copy).** Persist the TTL patch (or delete the doc) when shortening below the threshold; add the F2 symmetry re-check/comment. Small, closes the exemption's one correctness edge. | The durable store must never believe a key outlives what the cluster believes | `src/cluster/clusterCoordinator.ts` (`doPublishTtlChange`) |
| 7 | **Compact stale counter origins at hydration.** Replica names rotate every revision; long-lived counters accrue a dead origin per deploy generation (memory, event size, doc size). Fold origins absent from the live-node set into the seed during hydration — safe, since a gone node's contribution is final. Low urgency while counters are TTL'd; cheap to do while the code is warm. | Bounds per-counter growth across deploys | `src/store/store.ts`, `src/cluster/clusterCoordinator.ts` |
| 8 | **Add a shape check on inbound replication events.** `applyRemoteEvent` still applies `body as ReplicationEvent` with field-presence checks only. A ~30-line validator (kind-discriminated, size-bounded) hardens every node against a buggy or compromised publisher inside the topic's trust boundary. | Cheapest remaining hardening on the data plane | `src/cluster/clusterCoordinator.ts` or `src/cluster/types.ts` |
| 9 | **Write the operations runbook.** Now including: how to reach the admin port in Container Apps, "is replication flowing" (queue-depth gauge, `cluster.anti_entropy_reconciled` logs, `/admin/nodes` staleness), what `cluster.hydration_truncated` means and what to do, and the exemption's full-cluster-restart semantics. The tooling all exists; the page doesn't. | An incident at 3am shouldn't require reading the coordinator source | `docs/` |
| 10 | **Sweep the small carried floor.** Slow-command log (>10 ms, redacted key); flip `npm audit` to blocking once the transitive OTel advisory clears; measure whether the O(entry) accounting recompute matters at your real entry sizes (#3's data answers this too) and fix only if it does. | The long tail, none of it urgent, all of it cheap | various |

Everything below is the full re-assessed analysis.

---

<a name="system-overview"></a>
## System Overview

**Core business purpose.** Unchanged: a drop-in RESP2-compatible cache/pub-sub service (rate limiting, presence, Socket.IO fan-out, abuse guards) — durable and highly available across 2+ replicas via Service Bus replication and Cosmos DB persistence, an architecture now committed by an in-repo decision record grounded in operational evidence (managed Redis undeployable in this environment).

**System boundaries and interfaces:** unchanged from the fourth pass. Two Key Vault secrets total; managed identity for both Azure dependencies; RESP `:6379`, `/healthz`+`/readyz`, cluster-aware `/admin/*`, one Service Bus topic, two Cosmos containers, OTLP egress — now including cost telemetry (RU by operation, SB publishes, replication queue depth).

**What changed this pass (all verified):**
- **The replication pipeline is now cost-shaped end to end:** every event class coalesces (whole, ttl, incr, and now field via an in-place payload accumulator), short-TTL keys can skip the durable store entirely, deletes stay durable regardless (correctly — a skipped delete could be resurrected by hydration), and the heartbeat's Cosmos footprint is capped and self-cleaning.
- **The cost model is observable:** `requestCharge` captured per operation, publish counts, queue depth. Every remaining decision in the cost program is now an arithmetic exercise.
- **Anti-entropy rides server time** (`_ts`), removing the clock-skew hole.
- **The decision record exists** — the strategic ambiguity that shadowed passes three and four is closed in-repo.

**Key architectural decisions and drivers (delta view):**

| Decision | Driver | Assessment |
|---|---|---|
| Persistence exemption as an opt-in (`0` default) | Don't change durability semantics silently under existing operators | Defensible default for the *code*; wrong default for the *deployment* — the Bicep should set it (Top 10 #1) |
| Deletes always durable, even for exempt keys | A skipped delete is a resurrection bug waiting in hydration | Correct, and correctly reasoned in-code |
| Field coalescing via mutable tail-task payload | One net patch per drain without reordering | Clean design; the in-flight/queued distinction is handled correctly |
| Heartbeat top-N by subscriber count, exact totals kept | Bound RU growth with room count without losing the aggregate view | Right trade; `topBy` copies before sorting (no registry mutation) |
| Sequence: exemption before time gate, meters before both | Measure, then throttle only what measurement justifies | Exactly the discipline the fourth pass asked for |

---

<a name="architectural-patterns"></a>
## Architectural Patterns

No new pattern categories this pass — the existing ones matured:

- **Coalescing write-behind queue** is now complete across all four event classes. The field-payload accumulator (merge into the queued tail, never the in-flight head) is the textbook-correct implementation of batched delta coalescing.
- **Tiered durability** (new refinement): data now has three explicit tiers — ephemeral (pub/sub, never persisted), convergent-only (short-TTL keys, Service Bus without Cosmos, opt-in), and durable (everything else). This is the right taxonomy for a cache; its one edge case is F1, where a key *transitions* tiers via a TTL shorten and the durable copy isn't reconciled.
- **Metering as a design gate**: the time-gate decision (#4) deliberately waits on meter data. Institutionalizing "no optimization without a meter reading" is the discipline that keeps this codebase's cost story honest.
- **Decision records**: the ADR at the top of `docs/high-availability.md` closes the loop the third pass opened. Recommend adopting the format for future irreversible choices (capacity mode, sharding).

**Pattern effectiveness / conflicts:** none new. The exemption logic and the anti-entropy/hydration paths interact correctly for keys that were *always* exempt (they're simply absent from Cosmos); the F1 transition case is the single seam, and it's a two-line fix.

**Technical debt:** the enumerated list is the shortest it has been in five passes: F1/F2, origin compaction, event shape-check, runbook, slow-command log, the conditional time gate, and the conditionally-relevant O(entry) recompute. Nothing on the list is architectural.

---

<a name="scalability"></a>
## Scalability Analysis

**Horizontal (3/5, unchanged):** 2–5 full-copy replicas, connection-based autoscale, hydration bounded and expired-filtered. Ceiling remains one node's memory; growth path remains namespace sharding. With the exemption on, scale-out gets *cheaper and faster*: exempt keys don't hydrate (they were never persisted), so new-replica warm-up scales with the durable subset only — a nice emergent property worth stating in the docs.

**Vertical (4/5, unchanged):**
- Improved this pass: field coalescing bounds replication work under presence churn; the last O(keyspace) telemetry walk is gone; queue-depth is now visible before it becomes lag.
- Remaining, in measured-first order: O(entry) accounting recompute (decide with #3's data), `PUBLISH` local fan-out (the eventual ceiling, unchanged), `replicationQueueDepth()` iterating queue map per scrape (trivial at realistic key-churn; fine).

**Bottleneck trajectory:** with the exemption on and the indexing policy applied, the expected production profile is: Service Bus ops scale with write traffic (cheap), Cosmos RU scales with *durable* writes only (small), node CPU scales with fan-out. The meters will confirm or refute — which is the point.

---

<a name="reliability"></a>
## Reliability Review

**Fault tolerance (4/5, unchanged — the new work neither added failure modes nor removed defenses):**
- The exemption interacts correctly with the recovery ladder: exempt keys rely on Service Bus + peer copies only; a single-node restart re-converges them via live events; a full-cluster restart loses them — by explicit, documented contract (and they'd have expired anyway). Deletes staying durable closes the resurrection path.
- **F1 is this pass's one genuine reliability finding** (durable copy outliving the cluster's belief after a TTL shorten) — small, edge-case, fix specified in Top 10 #6.
- Heartbeat TTL means a crashed node's snapshot self-expires: `/admin/nodes` staleness and the doc lifecycle now agree.

**Disaster recovery (4/5, unchanged):** RPO now *explicitly tiered* — ≈replication-latency for durable keys, full-cluster-restart loss accepted for exempt keys (pre-HA contract). This tiering should appear in the runbook (#9) so an operator mid-incident knows which data classes came back.

**Remaining:** alert rules on the new gauges (queue depth sustained > N, RU slope, `anti_entropy_reconciled` applying > 0 repeatedly — a sign live replication is limping), and the runbook. Both are Phase-2 items with all their inputs now in place.

---

<a name="security"></a>
## Security Assessment

**Posture (4/5, unchanged):** no regressions; managed identity, auth throttling, supply-chain pinning, and the updated threat model all carried forward. The remaining items are the same two: a shape validator on inbound replication events (Top 10 #8 — the cheapest meaningful hardening left) and flipping the audit job to blocking when the transitive advisory clears. Nothing in PR #12 expanded the attack surface: the new metrics are process-local, the exemption reduces data-at-rest exposure (short-lived keys never touch Cosmos — a minor but real privacy improvement worth a line in `docs/security.md`).

---

<a name="cost"></a>
## Cost Efficiency

**Resource utilization assessment (4/5 — up from 3/5; the program is built, two switches from done):**

| Cost component | State after PR #12 |
|---|---|
| Cosmos writes | ✅ All coalescing classes live; ✅ exemption built (**flip it on — #1**); ✅ RU metered per operation; 📘 indexing policy specified (**apply it — #2**); ⬜ time gate deliberately deferred to data (#4) |
| Cosmos storage | ✅ Native TTL + exemption (exempt keys never stored at all) |
| Cosmos reads | ✅ Anti-entropy on `_ts` (index-covered); ✅ heartbeat capped + TTL'd; hydration reads shrink with the exemption |
| Service Bus | ✅ Ops metered; coalescing bounds them; Standard-tier base is the floor (~$10/mo) |
| Compute | 2–5 × small replicas; right-size after #3 |
| Observability of all of the above | ✅ The fourth pass's "unmeasured term" is now measured |

**What's left of the cost program, in full:** set one env var (#1), apply one container policy (#2), run one load test (#3), make two data-driven purchases (#4, #5). Assuming the exemption covers the rate-limit/sliding-window majority of writes and the indexing policy lands, the Cosmos line should end up scaling with *durable data change rate* — the correct and cheap shape — with Service Bus carrying the real-time load at cents per million operations.

**Projected end-state** (to be confirmed by #3's meters): fixed floor ≈ Service Bus Standard base + 2–3 small replicas + a modest RU baseline (heartbeats, anti-entropy queries, durable-key writes) — plausibly in the **$40–80/month** band at the workload scale these docs describe, versus the same order as the original single-replica design once the levers are flipped. For an architecture that also survives node loss and full-cluster restarts, that is the cost story resolved.

---

<a name="roadmap"></a>
## Implementation Roadmap

**Phase 1 — This week (mostly switches):** Top 10 #1 (env var in Bicep), #2 (apply indexing policy), #6 (F1 fix + F2 comment), #8 (event shape check). About a day of combined effort, most of it infra.

**Phase 2 — Next 4–6 weeks (measure and buy):** #3 metered load test → publish envelope; #4 time-gate decision; #5 capacity mode + RU alarm; alert rules on queue depth / anti-entropy activity; #9 runbook; O(entry) recompute verdict from the load-test data.

**Phase 3 — Opportunistic:** #7 origin compaction; slow-command log; blocking audit; `Buffer`-based values when memory × replicas becomes the binding constraint; namespace-sharding playbook when a second use-case cluster is first discussed. Review cadence can now drop from per-merge to **after the load test and after the first month of production meters** — the architecture has stopped moving.

---

<a name="metrics"></a>
## Architecture Metrics

**Quantitative assessments** (fourth pass → now):

| Dimension | Score | Basis |
|---|---|---|
| Performance | **4/5** (=) | Field coalescing + O(1) telemetry landed; remaining items are measure-first by design. |
| Reliability | **4/5** (=) | No new failure modes; recovery ladder intact; one small edge finding (F1) with a specified fix. |
| Security | **4/5** (=) | No regressions; two known small items remain (event shape check, blocking audit). |
| Cost | **4/5** (was 3/5) | Every lever from the cost program is built, documented, and metered; the remaining gap to 5/5 is literally flipping two switches and buying the right capacity mode with data. |
| Maintainability | **4/5** (=) | PR #12 continued the pattern: tests with every behavior change (190 total), docs updated in the same commit, decisions recorded. |

**Qualitative assessments:**
- *Fitness for purpose:* **High.** Five passes in, the system does what it promises, under the failure modes that matter, at a cost shape that now scales with the right variable (durable change rate, not traffic).
- *Future-proofing:* the tiered-durability taxonomy (ephemeral / convergent-only / durable) is the design's most future-proof property — new data classes slot into a tier instead of forcing a new mechanism.
- *Technical debt:* shortest list in the review's history; nothing architectural; every item has a specified fix or an explicit measure-first gate.
- *Team capability alignment:* the review→fix loop has now run four times with rising quality (this round: correct in-flight/queued coalescing semantics, correct delete-durability reasoning — subtle things done right unprompted). The residual skill dependency — Azure cost mechanics — is now encoded in meters and docs rather than resident in anyone's head.
- *Innovation potential:* the meters-before-throttles discipline and the ADR practice are the two exportable habits; the coalescing queue and tiered durability are reusable designs.

**Bottom line.** Pass one bounded the unbounded. Pass two refined it. Pass three found five defects and a premise question. Pass four turned a settled premise into a cost program. This pass verified the program built — and found the backlog finally *converging*: one env var, one container policy, one load test, two purchases, and a handful of small code items separate this system from its steady state. Flip the switches, read the meters for a week, buy accordingly. Then let it run — and let the next review be triggered by production data, not by another burst of construction.
