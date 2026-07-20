# BackendCache — Comprehensive Architectural Review (Sixth Pass: Close-Out)

**Date:** 2026-07-20 (sixth pass)
**Scope:** Full repository at commit `f842a8e` — source, tests, Dockerfile, Bicep infra, and docs.
**Context:** Since the fifth pass (at `d110029`), PR #14 delivered the remaining code items: the F1 TTL-shorten fix, the persistence exemption **enabled in the deployment** (`DURABILITY_MIN_TTL_MS=60000` in the Bicep), shape validation of inbound replication events, the slow-command log, the operations runbook, and a documented deferral of counter-origin compaction. This pass verifies that work and closes the review cycle: **every code-level item raised across five prior passes is now implemented, explicitly deferred with recorded reasoning, or gated on measurement by design.** What remains lives outside this repository — infra actions and data collection — and is listed below as an operational checklist rather than a Top 10 of changes.
**Verification:** typecheck clean, **200/200 tests passing** at head (including new `eventValidation` and `slowCommandLog` suites and expanded `durabilityExemption` coverage).

---

## Verification of the Fifth-Pass Items

| Fifth-pass item | Status | Notes |
|---|---|---|
| #1 Enable `DURABILITY_MIN_TTL_MS` in the deployment | ✅ **Done** | Bicep param (default `60000`) wired to the env var with in-template reasoning. The dominant RU saving is now on by default in the deployed configuration. |
| #6 Fix F1 (TTL-shorten stranding a longer-lived durable copy) | ✅ **Done — correctly** | `doPublishTtlChange` now *always* persists the TTL patch. The reasoning in-code is exactly right: `putTtl` 404-no-ops for born-exempt keys (so they still cost nothing), while the durable `INCR`+`EXPIRE`-to-short pattern gets its Cosmos doc stamped with the short native `ttl` so eviction and hydration filtering happen on the correct schedule. |
| F2 (threshold-straddling edge) | ✅ **Resolved by documentation** | The residual case (`SET key v PX <short>` over a *previously durable* key leaving the old durable copy) is analyzed in-code, shown not to occur in this cache's workloads, and given explicit workarounds. Accepting a non-occurring edge with recorded reasoning is the right call; the comment is where the next engineer will look. |
| #8 Shape-validate inbound replication events | ✅ **Done** | `validateReplicationEvent` (kind-discriminated, size-bounded) runs before every apply; malformed/oversized events are dropped and logged, closing the "replicated applies bypass admission control" hardening gap. Tested. |
| #9 Operations runbook | ✅ **Done** | `docs/runbook.md`: admin-API reachability in Container Apps, an ordered "is replication flowing" diagnostic (queue-depth gauge → anti-entropy `applied` counts as the limping-replication signal → node staleness), `hydration_truncated` response, and the exemption's restart semantics. Incident-ready, uses only existing tooling. |
| #10 Slow-command log | ✅ **Done** | >10 ms commands logged with redacted keys; tested. |
| #7 Counter-origin compaction | 📄 **Deferred, documented** | Deferral recorded with reasoning (counters are TTL'd in practice); acceptable closure — the trigger condition for revisiting (long-lived counters becoming a real pattern) is stated. |
| #2 Apply indexing policy / #3 load test / #4 time-gate decision / #5 capacity mode + alarm | ⬜ **Outside the repo** | All documented and metered from prior passes; these are infra actions and measurements, not code. See the checklist below. |

**No new findings.** This is the first pass in six with nothing to add to the defect list: the diff is small, test-covered, correctly reasoned in its edge cases, and consistent with every established pattern (validation before bypass paths, docs in the same commit, deferrals recorded rather than silent).

---

## The Remaining Work Is an Operational Checklist, Not a Review Backlog

In priority order — none of it is code in this repository:

1. **Apply the documented indexing policy to the real `keys` container** (`docs/deployment.md` has the JSON). Watch `backendcache.cosmos.request_units` drop per operation class to confirm the 2–5× write-RU reduction.
2. **Enable `DefaultTimeToLive` on the `keys` container** (the per-document `ttl` values are already being written; the container switch makes Cosmos honor them) — same doc, same section.
3. **Grant the managed identity its two roles** (Service Bus Data Owner scoped to the topic; Cosmos Built-in Data Contributor) and deploy the current Bicep — which now carries `REQUIRE_HA=true` and `DURABILITY_MIN_TTL_MS=60000`.
4. **Run the metered load test** (representative Socket.IO + rate-limit traffic): confirms the exemption's RU effect, produces the numbers for the time-gate decision (expected outcome: unnecessary post-exemption), node sizing, and the capacity envelope for the docs.
5. **Pick the Cosmos capacity mode from a week of meters and set the two alerts** the runbook already references: RU-consumption slope, and sustained replication-queue depth / repeated non-zero anti-entropy `applied` counts.
6. **Later, on stated triggers:** flip `npm audit` to blocking when the transitive OTel advisory clears; revisit origin compaction if long-lived counters appear; consider `Buffer` values when memory × replicas binds; O(entry) accounting only if the load test says it matters.

---

## Final Assessment

**Architecture metrics** (fifth pass → now):

| Dimension | Score | Basis |
|---|---|---|
| Performance | **4/5** (=) | All known event-loop and replication hot paths addressed or measure-gated; unproven under production load until checklist #4 runs. |
| Reliability | **4/5** (=) | F1 closed, inbound events validated, runbook in place; the last point is withheld pending the load test and live alert rules — reliability is now *believed*, not yet *demonstrated*. |
| Security | **4/5** (=) | Event validation closes the last code-side item; remaining: blocking audit (upstream-gated), role grants at deploy time. |
| Cost | **4/5** (=) | Every lever built, metered, and now *enabled in the deployment*; the last point awaits the container-side policy application and a data-driven capacity purchase (checklist #1, #2, #5). |
| Maintainability | **5/5** (was 4/5) | Six passes, ~40 findings: every one implemented, measure-gated, or deferred with recorded reasoning — none dropped silently. 200 tests that grew with every behavior change, an ADR, a runbook, and edge cases documented at the point of code. This codebase now maintains *itself* honestly; there is nothing structural left to deduct. |

**The arc, briefly.** Pass one found a well-designed single-node cache that trusted its network completely — and bounded it. Pass two verified the bounds and sharpened the semantics. Pass three met an architectural pivot (HA) and found five defects and a premise question; the defects were fixed stronger than asked, and the premise was settled by operational reality — managed Redis does not deploy here, and the decision is now an ADR in this repo. Pass four turned the committed architecture into a metered cost program; pass five verified the program and caught its one edge case; this pass verifies the edge case's fix and finds the backlog empty.

**Bottom line.** The review cycle is complete. BackendCache at `f842a8e` is a bounded, replicated, durable-where-it-matters, metered, documented, and runbook-equipped system with zero open code-level findings — something none of the five prior passes could say. The work that remains is deployment and measurement, listed above in order. The next review should not be scheduled; it should be **triggered** — by the load-test results, by the first month of production meters, or by the next architectural pivot. Until one of those arrives, the most valuable thing this document can do is stay exactly as it is: finished.
