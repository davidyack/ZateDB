# BackendCache — Comprehensive Architectural Review (Re-run)

**Date:** 2026-07-19 (second pass)
**Scope:** Full repository at commit `65ca295` — source (`src/`), tests, Dockerfile, Bicep infra sketch, and docs.
**Context:** This is a re-run of the review originally performed at commit `8da2e1b`. Between the two runs, the "Harden resource governance and security per architectural review" change (PR #5, `d5acec8`) implemented the previous report's Top 10. This pass **verifies each of those fixes against the actual code**, reports residual gaps found in the new implementation, and issues an updated Top 10. Verification included running the full suite at `65ca295`: typecheck clean, **102/102 tests passing** (including new `limits`, `setExpiry`, `maxClients`, and `outboundGuard` suites).
**Reviewer stance:** Senior-architect review across scalability, reliability, security, and cost lenses, calibrated to the system's stated intent (a deliberately narrow, single-replica, ephemeral RESP-compatible cache/pub-sub sidecar).

---

## Verification of the Previous Top 10

| # | Previous finding | Status | Verification notes |
|---|---|---|---|
| 1 | Bound keyspace memory | ✅ **Fixed** (with a residual gap) | `Store` now takes `maxKeys` (default 1 M) and `maxMemoryBytes` (default 384 MiB, sized below the 0.5 Gi container limit); new-key writes past the ceiling are rejected with Redis's exact `-OOM` error. Byte accounting is kept exact on every mutation path. **Residual:** the ceiling is enforced only at *new-key admission* — see new Top 10 #1. |
| 2 | Cap RESP frame/buffer sizes | ✅ **Fixed** | Parser enforces `maxBulkBytes` (8 MiB) per declared bulk string and `maxBufferBytes` (16 MiB) of pending unparsed data per connection; both configurable, both close the pre-auth OOM vector. Covered by new unit tests. |
| 3 | Socket write backpressure | ✅ **Fixed** | `Connection.write()` now destroys any connection whose `socket.writableLength` crosses `MAX_OUTBOUND_BUFFER_BYTES` (32 MiB), with a warning log — the `client-output-buffer-limit` equivalent. Covered by `outboundGuard` integration tests. |
| 4 | Timing-safe secret comparison | ✅ **Fixed** | `src/util/secureCompare.ts` hashes both sides to fixed-length SHA-256 digests and compares with `crypto.timingSafeEqual`; used by both the RESP `AUTH` path and the admin bearer check. Correctly handles the length-mismatch edge. |
| 5 | `SET NX/XX/GET/KEEPTTL` silently ignored | ✅ **Fixed** | `SET` now returns `ERR unsupported option '<opt>'` for any unimplemented option — loudly incomplete, as the façade philosophy requires. `EXPIRE`/`PEXPIRE` now use strict integer parsing (fractional TTLs rejected). |
| 6 | Fail closed/loudly on unset secrets | ✅ **Fixed at the "loud" level** | Prominent startup warnings (`backendcache.auth_disabled` / `admin_auth_disabled`, tagged with production status) and `/healthz` now exposes `authRequired` / `adminAuthRequired`. The stricter option (refuse to start in production) was not taken — an acceptable judgment call now that the state is visible; revisit if an incident proves the warning insufficient. |
| 7 | Connection limits + idle timeouts | ✅ **Fixed** | `MAX_CLIENTS` (10 k) rejects excess connections with `-ERR max number of clients reached`; `IDLE_TIMEOUT_MS` (5 min) reaps idle non-subscriber sockets, with subscribers correctly exempted at fire time. |
| 8 | Crash safety nets + readiness | ✅ **Fixed** | `uncaughtException`/`unhandledRejection` handlers log, drain, and exit(1); a non-protocol parser fault now kills only the offending socket; `/healthz` flips to 503 the moment shutdown begins, before the listener closes. |
| 9 | Saturation metrics | ✅ **Fixed** (with an efficiency note) | New `src/telemetry/saturation.ts`: event-loop lag p99, process RSS/heap, store byte estimate, connection count as observable gauges. Sweep-duration and outbound-buffer high-water metrics were not added — minor. **Note:** the store-bytes gauge calls `store.stats()` (an O(keyspace) walk) on every scrape — see new Top 10 #3. |
| 10 | Reproducible builds | ✅ **Mostly fixed** | `npm ci` in CI and both Dockerfile stages; the duplicate best-effort OTel install is gone (one deterministic `npm ci --omit=dev` keeps `optionalDependencies`). **Residual:** base image is still `node:20-slim` by tag, not digest-pinned, and CI has no `npm audit`/image scan. |

**Net effect:** every externally-triggerable OOM path identified in the first pass is closed, and the security floor (timing-safe compares, visible auth posture) is in. Fault tolerance moves from 2/5 to **4/5**; security from 3/5 to **4/5**. The remaining work is refinement, not firefighting.

---

## Top 10 Changes to Make Today (Updated)

The first three are residual gaps in the new hardening code itself; the rest are the highest-value items promoted from the previous roadmap. Nothing here is an emergency — the ranking is value-per-hour, and all items are authenticated-plane or operational concerns (the unauthenticated attack surface is now bounded).

| # | Change | Why | Where |
|---|--------|-----|-------|
| 1 | **Enforce the memory ceiling on existing-key growth.** `ensureRoomForNewKey()` runs only when a write creates a *new* top-level key. Growing an *existing* entry — `HSET` adding fields forever, `ZADD` adding members forever, `SET` replacing a small value with an 8 MiB one — adjusts `memoryBytes` but never checks it against `maxMemoryBytes`, so one authenticated caller with a single hot key can still sail past the ceiling. Check the ceiling on any mutation that increases `memoryBytes` (allowing writes that shrink), not just on new-key admission. | The flood-of-new-keys vector is closed, but the single-growing-key vector is not | `src/store/store.ts` (`hset`, `zadd`, `set`, `incr`) |
| 2 | **Make size accounting incremental.** `hset`/`hdel`/`zadd`/`zremrangebyscore` recompute `estimateEntrySize()` over the *entire* entry before and after every command — turning O(1) field writes into O(entry-size) walks, twice. A presence-mirror hash with 10 k fields pays a 20 k-iteration tax per single-field `HSET`, on the shared event loop. Compute the delta from just the touched fields/members (the per-field/member size formula is already additive). | Restores O(1) writes; the accounting exactness that motivated the recompute is preserved | `src/store/store.ts` |
| 3 | **Stop walking the keyspace on every metric scrape.** The `backendcache.store.memory_estimate_bytes` gauge calls `store.stats()` — an O(all keys) iteration — on each export interval. The store now maintains an exact `memoryBytes` counter for admission control; expose it via a cheap getter and have the gauge read that. Keep the independent recompute for `/admin/stats` only, where the cross-check is genuinely useful and operator-triggered. | At 1 M keys this is a recurring multi-ms event-loop stall purely to emit one number that's already known | `src/store/store.ts`, `src/telemetry/saturation.ts` |
| 4 | **Throttle failed `AUTH` attempts.** The password check is now timing-safe, but an internal attacker can still brute-force at TCP speed. Count failed `AUTH`/`HELLO AUTH` per connection and destroy after ~5 failures; log and count a metric. ~20 lines. | Completes the auth hardening story; trivially cheap | `src/commands/connectionCommands.ts`, `src/server/connection.ts` |
| 5 | **Make the TTL sweep incremental.** `sweepExpired()` still walks the full keyspace every 5 s regardless of TTL density. Either track TTL-bearing keys in a secondary set and walk only those, or adopt Redis's sampling approach (random 20, repeat while >25 % expired). | Removes the last O(keyspace) periodic stall from the data plane | `src/store/store.ts` |
| 6 | **Finish supply-chain pinning:** pin `node:20-slim` by digest in both Dockerfile stages, and add `npm audit --omit=dev` (or a dependabot config) plus an image scan step to CI. | The lockfile discipline is done; the base image and advisory monitoring are the open ends | `Dockerfile`, `.github/workflows/ci.yml` |
| 7 | **Add a slow-command log and sweep-duration metric.** Log any command handler exceeding ~10 ms (redacted key, duration, arg count) and time each sweep pass. These are the forensic complements to the new lag gauge: the gauge says *that* the loop stalled, these say *why*. | Turns saturation alerts into diagnosable events | `src/server/connection.ts` or `src/telemetry/commandTelemetry.ts` |
| 8 | **Bound shutdown time on the crash paths.** The `uncaughtException` handler awaits the full graceful drain — RESP shutdown is bounded (2 s grace), but HTTP keep-alive close and the OTel exporter flush are not; a hung exporter turns a crash into a zombie until the platform's kill grace expires. Add a hard `setTimeout(() => process.exit(code), 10_000).unref()` race around the drain. | A crash handler must never hang; today its worst case is platform-dependent | `src/index.ts` |
| 9 | **Document and decide admin-port reachability.** The Bicep exposes only 6379 via internal ingress; port 8082 is reachable only in-environment. Deployment docs gained the new limit env vars but still don't state how an operator actually reaches `/admin/*` in Container Apps (`az containerapp exec`? additional internal port mapping?). Decide, document, and add the runbook (symptom → admin endpoint → confirming metric) promised in the first review. | A break-glass tool you can't reach during an incident isn't one | `docs/deployment.md`, `docs/observability.md`, `infra/backendcache.bicep` |
| 10 | **Load-test the two ceilings and publish the envelope.** With bounds and gauges now in place, measure: (a) `PUBLISH` fan-out throughput vs. subscriber count, (b) write throughput vs. keyspace size, and record the measured capacity envelope plus the default limits' rationale in the docs. Also sweep up two nits while in there: `maxClientsError()` in `errors.ts` is dead code (the server inlines the same string), and a connection that subscribes then fully unsubscribes rejoins command mode with its idle timer already consumed. | Replaces guessed limits with measured ones; the defaults (384 MiB, 10 k clients, 32 MiB HWM) are currently educated guesses | `docs/`, `src/commands/errors.ts` |

Everything below is the full re-assessed analysis.

---

<a name="system-overview"></a>
## System Overview

**Core business purpose.** BackendCache satisfies a consuming application's *optional, cross-replica* Redis dependency — shared rate-limit counters, presence mirroring, Socket.IO fan-out, sliding-window abuse guards — without operating or paying for a managed Redis. The defining constraint: existing client libraries (`redis`/node-redis v5, `rate-limit-redis`, `@socket.io/redis-adapter`) must connect unmodified. Correctness is defined behaviorally ("does the real client work") rather than by spec coverage.

**Key requirements (inferred and documented):**
- Drop-in RESP2 wire compatibility for a ~20-command surface (strings, hashes, sorted sets, expiry, pub/sub).
- Binary-safe payloads (msgpack from the Socket.IO adapter).
- Data is ephemeral by contract — a restart resetting counters is an accepted cost.
- Single replica, internal-network-only, minimal operational surface.
- **New since first pass:** bounded resource consumption under hostile or buggy clients — now an explicit, implemented requirement rather than an assumption.

**System boundaries and interfaces:**
1. **RESP TCP `:6379`** — primary data plane; now guarded by `MAX_CLIENTS`, per-connection parser limits, idle reaping, and an outbound-buffer high-water mark.
2. **HTTP `:8081` `/healthz`** — liveness/readiness; now shutdown-aware (503 while draining) and exposes auth posture.
3. **HTTP `:8082` `/admin/*`** — token-gated operator JSON API (timing-safe bearer check).
4. **OTLP / Azure Monitor egress** — optional telemetry export, now including saturation gauges.

**Major components and interactions:**
- `RespServer` (`src/server/respServer.ts`) — TCP accept loop with connection cap, graceful shutdown.
- `Connection` (`src/server/connection.ts`) — per-socket RESP framing with limits, dispatch, pub/sub push, slow-consumer guard, idle reaping, mode state machine, disconnect cleanup.
- `dispatch` (`src/commands/dispatcher.ts`) — flat command table with per-command pre-auth and subscriber-mode gates.
- `Store` (`src/store/store.ts`) — single `Map<string, Entry>` with exact byte accounting and key/memory admission control; lazy expiry plus 5 s active sweep.
- `PubSubRegistry` (`src/pubsub/registry.ts`) — channel/pattern maps with reverse index for O(1) disconnect cleanup; synchronous fire-and-forget fan-out.
- `AdminServer` / `HealthServer` — separate `node:http` listeners.
- Telemetry (`src/telemetry/`) — `@opentelemetry/api` always; exporters optional; saturation gauges (`saturation.ts`) for lag/RSS/heap/store-bytes/connections.

**Data flow.** Client bytes → per-connection incremental parser (bounded) → dispatcher (auth gate → mode gate → handler) → synchronous store mutation (admission-controlled) → RESP frames written back (backpressure-guarded). No queues, no async boundaries inside a command.

**Technology stack and rationale.** Node 20 + TypeScript, zero hard runtime dependencies beyond `@opentelemetry/api`. Unchanged and still sound: single-threaded semantics make command atomicity free; the tiny dependency tree is a security and maintenance asset.

**Key architectural decisions and their drivers** (updated assessment):

| Decision | Driver | Assessment |
|---|---|---|
| Implement only the called command surface | Cost, attack surface | Sound — and now *consistently* executed: unsupported `SET` options error loudly, matching the unknown-command philosophy |
| Single replica, no HA | HA reintroduces the coordination problem the service solves | Sound; still recommend making `maxReplicas: 1` an explicitly documented safety invariant |
| In-memory only, no persistence | Ephemeral data contract | Sound — and now safe, with admission control preventing the "crash schedule" failure mode |
| Resource governance layer (new) | First review's findings | Well-implemented: exact accounting, Redis-compatible `-OOM`/max-clients errors, configurable via env, test-covered. Residuals in new Top 10 #1–3 |
| Network isolation as primary control, secrets as visible defense-in-depth | Internal-only ingress | Improved: fail-open configurations are now loud at startup and visible on `/healthz` |

---

<a name="architectural-patterns"></a>
## Architectural Patterns

**Patterns identified** (unchanged from first pass, with updated effectiveness):

- **Protocol façade / drop-in emulation** — the parser/serializer pair with exact Redis error-string compatibility. *Now stronger:* the façade is loudly incomplete everywhere examined (`ERR unknown command`, `ERR unsupported option`, `-OOM`, `-ERR max number of clients reached` all match or mirror real Redis text a client can branch on). The semantic-honesty inconsistency flagged in the first pass is resolved.
- **Command pattern with declarative gating** — unchanged, clean.
- **Per-connection state machine** — `command → subscriber` transitions now also interact correctly with the idle-reaper (subscribers exempt, checked at fire time). One micro-edge: a connection that subscribes then fully unsubscribes has consumed its idle-timeout event and won't be reaped until new traffic re-arms the timer (Top 10 #10 nit).
- **Publish–subscribe (fire-and-forget)** — now completed by the missing half of the pattern: a slow-consumer eviction policy. Delivery semantics still match real Redis.
- **Lazy + periodic expiry** — correct; the sweep remains a full keyspace walk (Top 10 #5).
- **Resource-governance / admission-control layer (new)** — limits are config-driven with sane defaults, enforcement sits at the correct chokepoints (parser, accept loop, write path, store admission), and every limit is integration- or unit-tested. This is the textbook shape for the pattern. Its two implementation residuals (existing-key growth bypass, O(entry) accounting) are the top of the new list.
- **Optional-dependency telemetry** — unchanged; the Dockerfile now relies on it properly instead of a duplicate best-effort install.

**Pattern conflicts:** none observed. The admission-control layer composes cleanly with the command pattern (limits throw typed errors; handlers map them to RESP frames centrally).

**Technical debt implications:** the deliberate debt (narrow surface, single replica) remains documented and priced. The undocumented-debt category from the first pass — the missing resource-governance layer — has been paid down. What remains is *refinement debt*: the three implementation residuals above, plus the still-guessed default limit values (Top 10 #10).

---

<a name="scalability"></a>
## Scalability Analysis

**Horizontal scaling assessment (1/5 — deliberately, unchanged):**
- The process is the state; `maxReplicas: 1` is a correctness invariant, not a capacity knob. Two replicas would silently split the keyspace and pub/sub topology. Still recommend a startup log + doc warning making the invariant explicit.
- Future capacity growth path remains *namespace sharding at the client* (independent single-replica instances per use case), never clustered replication.

**Vertical scaling assessment (3/5, unchanged score with shifted composition):**
- *Improved:* the parser's unbounded-buffer O(n²) risk is capped; slow consumers can no longer inflate RSS; the keyspace can no longer grow past the container limit. The failure mode under overload is now *rejection* (correct) instead of *death*.
- *New regression:* hash/sorted-set mutation cost went from O(fields touched) to O(entry size) due to the full-entry size recomputation (Top 10 #2). At small entry sizes this is noise; at 10 k-field presence hashes it's a real per-write tax.
- *Bottlenecks (re-ranked):*
  1. **`PUBLISH` fan-out** — still synchronous O(subscribers) per message on the shared loop; now survivable (slow consumers get dropped) but not faster. First wall as Socket.IO traffic grows.
  2. **Full-entry size recompute on hash/zset writes** (new — Top 10 #2).
  3. **`sweepExpired` full walk every 5 s** (Top 10 #5) and **`store.stats()` per metric scrape** (Top 10 #3) — same O(keyspace) shape, now two callers.
  4. **`zremrangebyscore`/`zcount` O(n) scans** — acceptable for bounded sliding-window sets.
  5. Parser `Buffer.concat` growth — now bounded by `maxBufferBytes`; no longer a meaningful risk.
- *Memory:* latin1-in-JS-strings still costs up to 2× raw payload bytes; the 384 MiB default ceiling accounts for this implicitly. `Buffer`-based values remain the right Phase 3 refactor and would roughly double effective capacity at the same limit.

**System bottlenecks:** the leading indicator (event-loop lag p99) is now actually exported — the first pass's core observability complaint is resolved. Health-probe starvation under a fan-out stall remains possible in principle; the generous liveness period (15 s) is still the right mitigation.

---

<a name="reliability"></a>
## Reliability Review

**Fault tolerance assessment (4/5, up from 2/5):**

| Failure | Behavior now | Assessment |
|---|---|---|
| Client floods new keys | Rejected with `-OOM` at admission; state preserved | ✅ Closed |
| Client grows one existing key forever | Accounting tracks it but nothing rejects it | ⚠️ Residual (Top 10 #1) |
| Huge/never-completing frame, pre-auth | Connection killed at 8 MiB bulk / 16 MiB buffer | ✅ Closed |
| Slow/stalled subscriber | Destroyed at 32 MiB outbound backlog, logged | ✅ Closed |
| Connection/FD leak or scan | Refused past 10 k clients; idle non-subscribers reaped at 5 min | ✅ Closed |
| Unhandled exception in handler/parser | Socket-scoped kill for parser faults; process-level handlers drain and exit(1) for the rest | ✅ Closed (bound the drain — Top 10 #8) |
| Redeploy / scale event | Readiness 503 before listener close; drain; bounded RESP grace | ✅ Improved |
| BackendCache down | Consuming app degrades (optional dependency) | ✅ Unchanged systemic strength |

- *Degradation strategy:* now exists and is the correct one for a cache — shed load (reject writes, refuse connections, drop slow consumers) rather than degrade for everyone.
- *Remaining gaps:* unbounded crash-path drain (Top 10 #8); no lag-based readiness signal (Phase 2); no failed-auth throttle (Top 10 #4).

**Disaster recovery capability (2/5 — unchanged, and appropriate):**
- No persistence by design; RPO = loss of ephemeral state, contractually accepted. RTO = restart + client reconnect ≈ seconds.
- The contract-drift risk (someone storing durable data in a fluent-Redis-speaker) remains the real DR exposure; the mitigation is still documentation + key-prefix conventions. The restart fail-open window for abuse guards still deserves a line in `docs/security.md`.
- Optional snapshot-on-shutdown remains a Phase 3 option *only if* the fail-open window proves to matter in practice.

**Reliability improvements:**
- *Immediate:* new Top 10 #1, #4, #8.
- *Medium-term:* incremental sweep (#5), slow-command log (#7), lag-based readiness, ops runbook (#9).
- *Long-term:* only measured-need items — snapshot/restore, TLS, capacity re-evaluation.
- *Monitoring:* the saturation gauges close the first pass's headline gap. Add alert rules on: lag p99 > ~50 ms sustained, store bytes > 80 % of ceiling, connections > 80 % of max, RSS approaching container limit, and (once added) failed-auth counter.

---

<a name="security"></a>
## Security Assessment

**Security measures evaluation:**
- *Authentication:* RESP `AUTH`/`HELLO AUTH` with correct pre-auth gating; admin bearer token; **both comparisons now constant-time** via hashed `timingSafeEqual`. Remaining: no failed-attempt throttle (Top 10 #4).
- *Authorization:* all-or-nothing per plane — still appropriate for scope.
- *Encryption:* none in transit/at rest; VNet isolation remains the control. Unchanged posture, unchanged acceptance for v1; TLS is the compliance-driven next step if ever required.
- *API security:* admin list endpoint still never returns values (anti-exfil by design); single-key reads/deletes logged and metered. Bearer check timing-safe.
- *Network security:* internal-only ingress, no public IP. Admin-port reachability still undocumented (Top 10 #9).
- *Audit logging:* unchanged, good. Auth posture now visible on `/healthz` — a genuine misconfiguration-detection improvement.

**Vulnerability analysis:**
- *Attack surface:* three listeners, ~20 commands, no scripting, no deserialization of untrusted formats. **The pre-auth surface is now bounded**: an unauthenticated peer can hold at most `maxClients` sockets × `maxBufferBytes` pending bytes (10 k × 16 MiB is theoretically 160 GiB — but per-socket kernel/user memory is bounded by the buffer cap per connection and connections are refused past the cap; practical exposure is governed by `MAX_CLIENTS`, which operators should size to the real fleet, e.g. 100–500, rather than the generous 10 k default).
- *Ranked residual exposures:*
  1. Existing-key growth bypassing the memory ceiling (authenticated only — Top 10 #1).
  2. `AUTH` brute-force at line speed (Top 10 #4).
  3. Fail-open-by-default secrets — now loud, but still permitted in production (accepted, monitored via `/healthz`).
  4. Base image unpinned; no advisory scanning in CI (Top 10 #6).
- *Data privacy:* unchanged — keys redacted in spans; admin single-key reads are the logged, targeted exception.
- *Third-party risks:* near-zero runtime tree; lockfile discipline now enforced end-to-end by `npm ci`.

**Security recommendations:** Top 10 #1, #4, #6; then TLS only if compliance demands; document the abuse-guard fail-open window on restart in `docs/security.md`; consider lowering the `MAX_CLIENTS` default toward realistic fleet size so the aggregate pre-auth buffer exposure shrinks correspondingly.

---

<a name="cost"></a>
## Cost Efficiency

**Resource utilization assessment (4/5, unchanged):**
- *Compute:* 0.25 vCPU / 0.5 Gi ≈ $10–15/month vs. multiples of that for a managed Redis with equivalent isolation. The cost thesis holds. The 384 MiB store ceiling + Node baseline fits the 0.5 Gi allocation with sensible headroom — the first pass's "right-size from measurement" recommendation is now half-done (defaults chosen from reasoning; Top 10 #10 replaces reasoning with measurement).
- *Storage/network/licenses:* none / internal-only / none. Unchanged.
- *Operational overhead:* the ownership cost of a protocol implementation, still well-fenced by the behavioral test suite (now 102 tests) and the CI coverage audit. The hardening added ~800 lines with tests — the fence held: scope did not expand, robustness did.

**Cost optimization suggestions:**
- *Immediate:* none needed. Do not shrink below 0.25 vCPU.
- *Right-sizing:* after Top 10 #10's load test, revisit `MAX_MEMORY_BYTES`/container memory together; the pair should move in lockstep (ceiling ≈ container limit − Node baseline − 30 % headroom).
- *Architectural:* `Buffer`-based values (Phase 3) roughly halves memory per stored byte — the cheapest capacity doubling available. Continue resisting speculative HA; the docs' discipline on this remains correct.
- *Automation:* add image build/push/deploy stages to CI before production; the Bicep sketch plus manual deploy is fine until then.

---

<a name="roadmap"></a>
## Implementation Roadmap

**Phase 1 — Immediate (this week): close the residuals.**
New Top 10 #1–4 and #8: ceiling enforcement on existing-key growth, incremental size accounting, cheap memory gauge, failed-auth throttling, bounded crash-path shutdown. All are small, localized changes to code merged this week while context is fresh. Estimated effort: ~1 focused day.

**Phase 2 — 3–6 months: operational maturity.**
- Incremental/sampled TTL sweep (#5); slow-command log + sweep-duration metric (#7).
- Supply-chain: digest-pinned base image, `npm audit`, image scan (#6).
- Admin-port reachability decision + ops runbook (#9).
- Alert rules on the saturation gauges (thresholds listed in Reliability).
- Load test the fan-out and write ceilings; publish the measured capacity envelope and re-derive default limits from it (#10).
- Lag-based readiness (sustained event-loop lag → 503) — with care not to flap under transient spikes.
- CI deploy pipeline (build/push/deploy) when production-bound.

**Phase 3 — 6–12 months: evolution only where measured.**
- `Buffer`-based value storage (halve payload memory, drop latin1 round-trips).
- Optional snapshot-on-shutdown/restore — only if the restart fail-open window proves material.
- TLS on the RESP listener if compliance requires encrypted internal hops.
- Namespace-sharding playbook as the documented capacity answer — explicitly instead of replication.
- Revisit single-replica only if BackendCache's own availability becomes a *measured* problem. That discipline held through this cycle; keep it.

---

<a name="metrics"></a>
## Architecture Metrics

**Quantitative assessments** (first-pass score → current):

| Dimension | Score | Basis |
|---|---|---|
| Performance | **4/5** (=) | µs-scale ops at target load; deduct for the new O(entry) accounting tax and the still-unmeasured fan-out ceiling. |
| Reliability | **4/5** (was 2/5) | Every externally-triggerable OOM path closed with tests; load-shedding degradation in place; crash safety nets present. Deduct for the existing-key-growth residual and unbounded crash-path drain. |
| Security | **4/5** (was 3/5) | Timing-safe secrets, visible auth posture, bounded pre-auth surface, deterministic supply chain. Deduct for no auth throttling and unpinned base image. |
| Cost | **5/5** (=) | ~$10–15/month; zero licenses; near-zero dependency maintenance; hardening added no run cost. |
| Maintainability | **4/5** (=) | The hardening landed idiomatically with tests and doc updates; the semantic-honesty inconsistency is fixed. Deduct for the size-accounting complexity now threaded through every store mutation — worth consolidating when implementing Top 10 #2. |

**Qualitative assessments:**
- *Fitness for purpose:* **High.** Unchanged verdict, now with the resource-governance layer a network-facing cache requires.
- *Future-proofing:* **Good.** The coverage-audit fence and documented non-goals continue to keep scope honest; the limits are all env-tunable so operational learning doesn't require code changes.
- *Technical debt:* the first pass's systemic finding ("an unbounded thing needs a bound") is resolved. Remaining debt is small, named, and localized (new Top 10 #1–3 plus the guessed default limits).
- *Team capability alignment:* unchanged — TypeScript/Node, no exotic ops skills, and the review→fix cycle this week demonstrates the codebase absorbs directed change quickly and safely (102 green tests).
- *Innovation potential:* appropriately low; the notable practice worth propagating is unchanged — correctness defined by real-client behavior, now extended to limit behavior (`maxClients`, outbound-guard, and limits test suites exercise real sockets, not mocks).

**Bottom line.** The first review's central weakness — a server that trusted its network completely on resource consumption — has been engineered out, verifiably and with tests. The system is now sound for production use within its stated contract. Today's list is refinement: close the existing-key-growth loophole, make the new accounting O(1), keep the metrics cheap, and replace guessed limits with measured ones.
