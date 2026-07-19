# BackendCache — Comprehensive Architectural Review

**Date:** 2026-07-19
**Scope:** Full repository at commit `8da2e1b` — source (`src/`), tests, Dockerfile, Bicep infra sketch, and docs.
**Reviewer stance:** Senior-architect review across scalability, reliability, security, and cost lenses, calibrated to the system's stated intent (a deliberately narrow, single-replica, ephemeral RESP-compatible cache/pub-sub sidecar) rather than judging it as a general-purpose Redis replacement.

---

## Top 10 Changes to Make Today

Ranked by risk-reduction per hour of effort. Items 1–3 close denial-of-service/OOM holes reachable by any client that can open a TCP connection; 4–6 are security and correctness footguns; 7–10 harden operations.

| # | Change | Why now | Where |
|---|--------|---------|-------|
| 1 | **Bound the keyspace memory.** Add a `MAX_MEMORY_BYTES` (or max-keys) guard: reject writes (`-OOM command not allowed`) or evict-with-TTL-first when the estimate exceeds the limit. The store is an unbounded `Map` in a 0.5 Gi container — one misbehaving caller (or key-cardinality bug in the consuming app) OOM-kills the process and wipes *all* rate-limit/presence state at once. | OOM = total outage + silent state reset | `src/store/store.ts`, `src/config.ts` |
| 2 | **Cap RESP frame and buffer sizes in the parser.** The inline path caps at 64 KB, but the array path will happily buffer a declared `$<huge>` bulk string forever, and `Buffer.concat` per chunk is O(n²) as the frame grows. Enforce a max bulk length (e.g. 8 MB) and max total pending-buffer size per connection; kill the connection with a protocol error beyond it. | Unauthenticated pre-`AUTH` memory-exhaustion vector | `src/resp/parser.ts` |
| 3 | **Handle socket write backpressure.** `Connection.write()` ignores `socket.write()`'s return value. A slow or stalled subscriber makes `PUBLISH` fan-out queue unbounded data in Node's outbound buffer — this is exactly why Redis has `client-output-buffer-limit pubsub`. Track `socket.writableLength` (or the `false` return + `drain`), and destroy connections whose buffer exceeds a threshold (e.g. 32 MB or 60 s stalled). | Slow consumer can OOM the whole server | `src/server/connection.ts` |
| 4 | **Constant-time secret comparison.** `password === ctx.config.authPassword` and `header === 'Bearer ' + adminToken` are timing-comparable. Use `crypto.timingSafeEqual` over hashed/length-normalized inputs for both the RESP `AUTH` path and the admin bearer check. ~15 lines. | Cheap elimination of a classic side channel | `src/commands/connectionCommands.ts:57`, `src/http/adminServer.ts:85` |
| 5 | **Stop silently ignoring `SET NX/XX/GET/KEEPTTL`.** Today `SET k v NX` returns `+OK` and *unconditionally overwrites*. Any future caller using the standard `SET NX` lock/idempotency idiom gets silently broken semantics — the worst failure mode (looks like success, isn't). Return `ERR unsupported option` instead, matching the repo's own "unknown command errors loudly" philosophy. Same review for `EXPIRE` with non-integer seconds (currently accepts floats). | Correctness time bomb; contradicts the project's core design principle | `src/commands/stringCommands.ts:33-63` |
| 6 | **Fail closed (or loudly) when secrets are unset.** The admin API is wide open when `ADMIN_TOKEN` is unset, and RESP requires no auth when `REDIS_AUTH_PASSWORD` is unset — both silent. In production (`NODE_ENV=production`), refuse to start without both, or at minimum log a prominent startup warning and expose `authRequired:false` in `/healthz` so it's visible. | Misconfiguration today = open admin delete/read surface | `src/http/adminServer.ts:83`, `src/index.ts` |
| 7 | **Add connection limits and idle timeouts.** No `maxclients` equivalent and no `socket.setTimeout` — an FD/connection leak in a consuming app (or a port scan on an internal network) accumulates connections forever. Cap concurrent connections (reject with `-ERR max clients reached`) and destroy sockets idle beyond e.g. 5 min *unless subscribed*. | Second resource-exhaustion vector after memory | `src/server/respServer.ts` |
| 8 | **Add `uncaughtException`/`unhandledRejection` handlers** that log and exit(1) after attempting the existing graceful shutdown, and make `/healthz` return 503 once shutdown begins (readiness must go false before the listener closes to avoid a redeploy blip). Also fix `connection.ts:58` — a non-`RespProtocolError` throw from the parser currently propagates as an uncaught `'data'`-handler exception and crashes the process. | One bad frame or bug shouldn't take the whole cache down untraced | `src/index.ts`, `src/server/connection.ts`, `src/http/healthServer.ts` |
| 9 | **Add saturation metrics:** event-loop lag, `process.memoryUsage().rss`/heap, store `memoryEstimateBytes` as a gauge, TTL-sweep duration, and per-connection outbound-buffer high-water mark. These are the metrics that predict the failure modes in items 1–3, and none exist today (only throughput counters do). | You can't alert on the failure modes that matter | `src/telemetry/commandTelemetry.ts` |
| 10 | **Make builds reproducible:** use `npm ci` (not `npm install`) in CI and both Dockerfile stages; drop the duplicate best-effort `npm install` of OTel exporters in the runtime stage (they're already declared as `optionalDependencies`, so one `npm ci --omit=dev` does it deterministically); pin the base image by digest. | Unpinned installs = untracked supply-chain and drift risk | `Dockerfile`, `.github/workflows/ci.yml` |

Everything below is the full analysis backing these recommendations.

---

<a name="system-overview"></a>
## System Overview

**Core business purpose.** BackendCache satisfies a consuming application's *optional, cross-replica* Redis dependency — shared rate-limit counters, presence mirroring, Socket.IO fan-out, sliding-window abuse guards — without operating or paying for a managed Redis. The defining constraint: existing client libraries (`redis`/node-redis v5, `rate-limit-redis`, `@socket.io/redis-adapter`) must connect unmodified. Correctness is therefore defined behaviorally ("does the real client work") rather than by spec coverage.

**Key requirements (inferred and documented):**
- Drop-in RESP2 wire compatibility for a ~20-command surface (strings, hashes, sorted sets, expiry, pub/sub).
- Binary-safe payloads (msgpack from the Socket.IO adapter).
- Data is ephemeral by contract — a restart resetting counters is an accepted cost.
- Single replica, internal-network-only, minimal operational surface.

**System boundaries and interfaces:**
1. **RESP TCP `:6379`** — the primary data plane; consumed by app replicas via `REDIS_URL`.
2. **HTTP `:8081` `/healthz`** — liveness/readiness for the orchestrator.
3. **HTTP `:8082` `/admin/*`** — token-gated operator JSON API (stats, key inspection, targeted delete, pub/sub topology).
4. **OTLP / Azure Monitor egress** — optional telemetry export.

**Major components and interactions:**
- `RespServer` (`src/server/respServer.ts`) — TCP accept loop, connection set, graceful shutdown.
- `Connection` (`src/server/connection.ts`) — per-socket RESP framing, dispatch, pub/sub push, mode state machine (`command` → `subscriber`), disconnect cleanup.
- `dispatch` (`src/commands/dispatcher.ts`) — flat command table with per-command pre-auth and subscriber-mode gates.
- `Store` (`src/store/store.ts`) — single `Map<string, Entry>`; lazy expiry on access plus a 5 s active sweep.
- `PubSubRegistry` (`src/pubsub/registry.ts`) — channel/pattern maps with a reverse index for O(1) disconnect cleanup; synchronous fire-and-forget fan-out.
- `AdminServer` / `HealthServer` — separate `node:http` listeners.
- Telemetry (`src/telemetry/`) — `@opentelemetry/api` always; exporters optional, degrading to no-op.

**Data flow.** Client bytes → per-connection incremental parser → dispatcher (auth gate → mode gate → handler) → synchronous store mutation → pre-serialized RESP frames written back. `PUBLISH` synchronously walks exact-match subscribers then every registered pattern regex. There is no queue, no async boundary, and no I/O inside a command — the design's simplicity and its scaling ceiling in one property.

**Technology stack and rationale.** Node 20 + TypeScript, zero hard runtime dependencies beyond `@opentelemetry/api`. This is a defensible choice: the consuming team's stack, a tiny supply-chain surface, and single-threaded semantics that make command atomicity free (Redis itself is single-threaded for the same reason). The trade-off — event-loop sensitivity to O(n) work — is real and analyzed below.

**Key architectural decisions and drivers:**

| Decision | Driver | Assessment |
|---|---|---|
| Implement only the called command surface | Minimize build/maintenance cost; smaller attack surface | Sound, with one execution flaw (silently ignored `SET` options — see Top 10 #5) |
| Single replica, no HA | HA would reintroduce the coordination problem the service solves; matches status-quo risk | Sound *for the stated data classes*; must remain enforced by contract (see Reliability) |
| In-memory only, no persistence | Data is ephemeral by contract | Sound; needs memory bounding to be safe (Top 10 #1) |
| latin1 (`binary`) string round-trip for payloads | Binary safety for msgpack, proven by integration test | Correct; 2×-memory and future-refactor implications (see Cost) |
| Network isolation as primary security control | Internal-only ingress; secrets as defense-in-depth | Reasonable, but currently *fails open* when secrets are unset (Top 10 #6) |
| Synchronous per-command execution, no clustering | Simplicity; free atomicity | Sound at target scale; ceiling documented below |

---

<a name="architectural-patterns"></a>
## Architectural Patterns

**Patterns identified:**

- **Protocol façade / drop-in emulation.** The whole system is a façade implementing a foreign wire protocol (RESP2) over a private store. Implemented via the incremental parser + serializer pair with exact Redis error-string compatibility (`WRONGTYPE…`, `ERR wrong number of arguments…`), because real clients branch on those strings. Chosen so consuming code needs zero changes.
- **Command pattern with declarative gating.** Flat `COMMANDS` table; each entry declares `allowedPreAuth`/`allowedInSubscriberMode`, so security/mode policy is data, not scattered conditionals. Handlers validate their own args and return pre-built reply frames.
- **Per-connection state machine.** `handshake → command → subscriber → closed`, mirroring Redis's subscriber-connection restriction.
- **Publish–subscribe (fire-and-forget).** Synchronous fan-out, no queue/persistence — deliberately matching real Redis pub/sub semantics so consuming apps inherit identical delivery guarantees.
- **Lazy + periodic expiry** (cache-expiry pattern): expiry checked on access, plus a low-frequency full sweep.
- **Sidecar/embedded-infrastructure deployment**: deployed inside the consuming app's Container Apps environment, not as shared central infrastructure.
- **Optional-dependency telemetry (graceful degradation).** Exporters are `optionalDependencies` with ambient type stubs; absent exporters degrade to the no-op provider rather than failing startup.

**Pattern effectiveness analysis:**

- *Protocol façade*: excellent fit, and the test strategy (integration tests against real client libraries plus a CI command-coverage audit) is the right way to verify a façade — this caught the UTF-8/binary corruption issue hand-written tests missed. The façade's residual risk is **semantic** (not wire) divergence: options accepted-but-ignored (`SET NX`), floats accepted by `EXPIRE`, `CLIENT <anything>` returning `+OK`. A façade must be *loudly incomplete*, never silently different. The repo states this principle for unknown commands but violates it for known-command options — the single most important pattern-level fix.
- *Command table*: clean, and centralizing pre-auth/mode gates in the dispatcher is the correct place. No conflicts.
- *Pub/sub*: correct semantics; disconnect cleanup via reverse index is well done. The gap is flow control on the outbound side (Top 10 #3) — the pattern is incomplete without a slow-consumer policy. Pattern matching is O(patterns) regex tests per publish; fine at expected cardinality (the Socket.IO adapter uses a handful of channels), worth a note in code if pattern counts ever grow.
- *Lazy + sweep expiry*: right pattern; the sweep is a full keyspace walk (see Scalability) and should become incremental if the keyspace grows.
- *Alternatives considered and rightly rejected*: embedding Redis itself (operational and licensing surface), a custom SDK/protocol (would forfeit the drop-in property, the system's raison d'être), and clustered HA (reintroduces the coordination problem). These rejections are documented in-repo, which is exemplary decision hygiene.
- *Technical debt implications*: the deliberate debt (narrow command surface, single replica) is documented and priced. The **undocumented** debt is the missing resource-governance layer — memory bounds, frame caps, backpressure, connection limits — which every network-facing cache needs regardless of scope narrowness. That layer is the theme of this review.

---

<a name="scalability"></a>
## Scalability Analysis

**Horizontal scaling assessment (1/5 — deliberately):**
- *Stateless vs stateful*: the process **is** the state; no externalization. Score of 1 is by design, not by accident — the Bicep pins `minReplicas: 1, maxReplicas: 1` and documents why. Two replicas behind Container Apps' TCP load balancing would silently split the keyspace and pub/sub topology (a client's rate-limit counter would depend on which replica its connection landed on) — a *correctness* failure, not a capacity one. **Recommendation:** treat `maxReplicas: 1` as a safety invariant, not a tuning knob — add a startup log line and a doc warning that >1 replica is a correctness violation, so a future infra edit can't "helpfully" scale it.
- *Data partitioning*: none; single keyspace. If capacity is ever exceeded, the correct evolution is *namespace sharding at the client* (rate-limits → instance A, Socket.IO → instance B) — multiple independent single-replica instances — long before attempting clustered replication.
- *Caching architecture*: BackendCache *is* the cache tier; there is deliberately no L2.
- *Load balancing / service discovery*: single internal FQDN from Container Apps ingress; adequate.

**Vertical scaling assessment (3/5):**
- *Resource utilization*: single-threaded event loop → effective ceiling of one CPU core; the provisioned 0.25 vCPU / 0.5 Gi is proportionate to the workload but leaves little headroom for fan-out spikes. Node.js overhead (~50–80 MB RSS baseline) consumes a meaningful fraction of 0.5 Gi.
- *Performance bottlenecks (ranked)*:
  1. **`PUBLISH` fan-out** — synchronous serialize+write per subscriber, plus regex per registered pattern. With S subscribers this is O(S) inside one event-loop tick; a large Socket.IO room broadcast blocks all other commands for its duration.
  2. **`sweepExpired`** — full keyspace walk every 5 s regardless of how many keys have TTLs. At 1 M keys this is a multi-millisecond stall every 5 s. Fix cheaply by iterating only TTL-bearing keys (maintain a secondary set) or sampling like Redis does (random 20, repeat while >25% expired).
  3. **`zremrangebyscore`/`zcount`** — O(n) scans of the member map (Redis uses a skiplist for O(log n + m)). Fine for sliding-window sets (bounded by window size); would degrade with large sorted sets.
  4. **`listKeys` (admin)** — O(n) scan + full sort on every request; acceptable for an operator endpoint, but note it shares the event loop with the data plane — an admin paging through a huge keyspace stalls production traffic.
  5. **Parser `Buffer.concat` per chunk** — O(frame²) for large fragmented frames; capped frames (Top 10 #2) also cap this.
- *Memory optimization*: latin1-in-JS-strings stores every payload byte as a 2-byte UTF-16 unit in the worst case — up to 2× raw payload size (the `estimateEntrySize` function correctly multiplies by 2). Moving `Entry.value` to `Buffer` would halve payload memory and eliminate encode/decode; a worthwhile Phase-3 refactor, not urgent at current scale.
- *Database scaling strategy*: N/A — but the memory bound (Top 10 #1) is the substitute discipline: an unbounded in-memory store has no scaling strategy, only a crash schedule.

**System bottlenecks (current → future):**
- *Current*: none observed at target scale; the design comfortably serves the low-thousands ops/sec a small replica fleet generates.
- *Future*: pub/sub fan-out is the first wall (grows with connected Socket.IO clients × broadcast rate); event-loop lag is the leading indicator — which is why it must be a metric (Top 10 #9).
- *Data flow constraints*: everything shares one event loop, including health checks — under a fan-out stall, `/healthz` slows too, and an aggressive liveness probe could restart a merely-busy instance. Keep `periodSeconds`/timeouts generous on liveness (current 15 s period is fine; ensure `timeoutSeconds` ≥ 5).
- *Network limitations*: internal east-west traffic only; not a concern at target scale.
- *Third-party dependencies*: effectively none on the data plane — a genuine scalability *and* reliability asset.

---

<a name="reliability"></a>
## Reliability Review

**Fault tolerance assessment (2/5):**
- *Failure modes analysis*:
  | Failure | Today's behavior | Assessment |
  |---|---|---|
  | Process crash / OOM | All state lost; Container Apps restarts; clients reconnect | Acceptable *by data contract*, but currently too easy to trigger externally (Top 10 #1–3) |
  | Unhandled exception in a handler | Propagates out of the `'data'` listener → process crash | **Gap** — one malformed input path = full outage (Top 10 #8) |
  | Slow subscriber | Unbounded outbound buffering → memory growth → OOM | **Gap** (Top 10 #3) |
  | Client floods writes | Unbounded keyspace growth → OOM | **Gap** (Top 10 #1) |
  | Redeploy / scale event | SIGTERM → stop accepting, drain, close; documented and implemented | Good — genuinely above-average shutdown discipline |
  | BackendCache down | Consuming app's Redis dependency is *optional* — degraded (per-replica limits, no fan-out) not dead | Good systemic property; verify the consuming clients actually have retry/reconnect with backoff configured |
- *Circuit breakers / retries / fallbacks*: correctly located in the **consumers** (node-redis reconnection, the app's optional-dependency posture). BackendCache itself has no downstream dependencies to break against. The one server-side fallback that matters is load shedding: reject-when-full (connections, memory) instead of degrade-for-everyone.
- *Service degradation*: none today — the server has no overload behavior other than slowing down and eventually dying. Items 1, 2, 3, 7 in the Top 10 collectively *are* the degradation strategy.

**Disaster recovery capability (2/5 — appropriate to the data contract):**
- *Backups / RPO*: no persistence by design; RPO = total loss of ephemeral state, contractually acceptable. **The real DR risk is contract drift**: nothing stops a future developer from storing durable data (sessions, tokens, business state) in a thing that speaks fluent Redis. Mitigate with a prominent contract statement in the README *and* an admin-visible signal (key-prefix conventions per use case make audits possible).
- *RTO*: container restart + client reconnect ≈ seconds. The post-restart behavior is well-understood: rate-limit windows reset (briefly more permissive — note this is a *fail-open* moment for abuse guards, worth stating in the security doc), Socket.IO adapters resubscribe automatically.
- *Multi-region*: out of scope, correctly.
- *Data consistency during failures*: single-writer, single-threaded — no partial-write states possible. Genuinely simple and correct.

**Reliability improvements:**
- *Immediate*: Top 10 items 1, 2, 3, 7, 8.
- *Medium-term*: incremental TTL sweep; readiness/liveness split (readiness false during shutdown *and* under sustained event-loop lag); load-shed threshold tied to the memory gauge.
- *Long-term / strategic*: only if measured need appears — optional snapshot-on-shutdown (restores rate-limit continuity across planned redeploys, cheap to build, no HA complexity), before ever considering replication.
- *Monitoring/observability gaps*: no saturation signals (Top 10 #9); no slow-command log (log any command > 10 ms with redacted key); `/admin/stats` `commandsPerSecond` is a lifetime average, not a rate — fine for `curl`, but alerts must come from the OTel counters.
- *Incident response*: the admin API (targeted key inspect/delete, pub/sub topology) is a well-designed break-glass tool. Add a documented runbook: symptoms → which admin endpoint → which metric confirms.

---

<a name="security"></a>
## Security Assessment

**Security measures evaluation:**
- *Authentication*: RESP `AUTH`/`HELLO AUTH` with a single shared password; correct pre-auth command gating in the dispatcher (only `AUTH`, `HELLO`, `PING`, `CLIENT`, `QUIT` before auth). Admin API uses a separate bearer token — the two-secret split with distinct blast radii is a genuinely good design and correctly documented.
- *Authorization*: all-or-nothing per plane (data vs admin). Appropriate for the scope; no per-key ACLs needed.
- *Encryption*: none in transit (plaintext RESP and HTTP), none at rest (no rest). In-transit relies on VNet isolation. Acceptable for v1 given internal-only ingress; TLS on the RESP listener is the standard next hardening step if compliance ever requires encryption on internal hops (node:tls wrap is straightforward; node-redis supports `rediss://`).
- *API security*: admin API never returns bulk values from the list endpoint (anti-exfiltration by design — excellent); single-key reads and deletes are explicit and logged. Gaps: no rate limiting on auth attempts on either plane (an internal attacker can brute-force the password at TCP speed), and non-constant-time comparisons (Top 10 #4).
- *Network security*: internal-only ingress, no public IP — the primary control, and stronger than a public managed Redis endpoint. Note the Bicep exposes only port 6379 through ingress; the admin port 8082 is reachable only pod-locally/via internal environment routing — decide explicitly and document how operators reach it (`az containerapp exec`, additional internal port mapping, or a jump path).
- *Audit logging*: every admin action logged + metered; deletes treated as auditable. Good.

**Vulnerability analysis:**
- *Attack surface*: three listeners, ~20 commands, no scripting/`EVAL` (documented as a deliberate non-goal — a real structural win), no deserialization of untrusted formats (payloads are opaque bytes). Small by construction.
- *Common vulnerability exposure (ranked)*:
  1. **Resource-exhaustion DoS pre-auth** — unbounded parser buffering (Top 10 #2), unbounded connections (#7), unbounded keyspace post-auth (#1), unbounded outbound buffers (#3). These are the exploitable findings.
  2. **Fail-open secrets** — unset `ADMIN_TOKEN`/`REDIS_AUTH_PASSWORD` silently disable auth (Top 10 #6).
  3. **Timing side channels** on both secret comparisons (Top 10 #4).
  4. **No auth attempt throttling** — add a small per-connection failed-`AUTH` counter (disconnect after ~5 failures).
- *Data privacy*: keys are redacted in span attributes (prefix+hash) — thoughtful. `GET /admin/keys/:key` returns full values to any token holder; the logging of that action is the compensating control. Payload contents are whatever the consuming app stores; the ephemeral contract limits exposure.
- *Compliance gaps*: no TLS on internal hops (matters under strict zero-trust mandates); container runs as `USER node` (good) — add `readOnlyRootFilesystem`/no-new-privileges equivalents where the platform allows.
- *Third-party risks*: near-zero runtime dependency tree is the standout security property. Protect it: `npm ci` + lockfile discipline (Top 10 #10) and a dependabot/audit job in CI.

**Security recommendations:**
- *Critical*: Top 10 #4 and #6; frame/connection caps (#2, #7) double as security fixes.
- *Pattern improvements*: failed-auth throttling; explicit `-ERR unsupported option` for unimplemented option flags (semantic honesty is a security property when the callers are rate-limiters and abuse guards — #5).
- *Infrastructure hardening*: pin image digests; add `npm audit`/scanning to CI; document the admin-port reachability decision.
- *Monitoring*: alert on auth-failure counter and on connection-count/memory saturation gauges.
- *Compliance*: document that rate-limit state resets on restart is a brief fail-open window for abuse guards — accepted risk, but it belongs in `docs/security.md`.

---

<a name="cost"></a>
## Cost Efficiency

**Resource utilization assessment (4/5):**
- *Compute*: 0.25 vCPU / 0.5 Gi single replica ≈ **$10–15/month** on Container Apps (consumption), vs. ~$16/month for the cheapest Azure Cache for Redis Basic C0 — but the honest comparison for the isolation level achieved (no public endpoint at all) is Basic/Standard + Private Endpoint, which lands at several times that. The cost thesis holds.
- *Storage*: none. *Network*: internal east-west only, effectively free. *Licenses*: none — and BackendCache neatly sidesteps the Redis licensing turbulence (RSALv2/SSPL era) that motivated many teams' migrations; zero runtime dependencies also mean near-zero ongoing upgrade toil.
- *Operational overhead*: **this is where the real cost lives.** The service trades a managed-service fee for ownership of a protocol implementation. The repo mitigates this unusually well — behavioral integration tests against real client libraries, a CI coverage audit, and documented non-goals form a cost *fence*: a new consuming-app dependency that needs an unsupported command fails loudly in integration tests rather than expanding scope silently. Maintain that fence; it is the cost model.

**Cost optimization suggestions:**
- *Immediate*: none needed — the footprint is already near-minimal. Don't shrink below 0.25 vCPU; headroom is cheaper than a fan-out stall.
- *Right-sizing*: after the saturation metrics (Top 10 #9) exist, size memory from the observed `memoryEstimateBytes` high-water mark + Node baseline + 50% headroom, and set `MAX_MEMORY_BYTES` below the container limit so the app rejects writes before the OOM-killer acts.
- *Reserved instances*: not applicable at this spend level; consumption pricing is correct.
- *Architectural*: the biggest avoidable *future* cost is speculative HA — the docs already resist it; keep resisting. Buffer-based value storage (Phase 3) halves memory per byte stored if memory ever drives sizing.
- *Automation*: the Bicep sketch plus CI is adequate; add image build/push + deploy stages to CI when the service goes to production so deploys don't become artisanal.
- *Maintenance-cost reduction*: the command-coverage audit script is the key asset — wire it to fail CI on drift (if it doesn't already) so protocol scope can only expand deliberately.

---

<a name="roadmap"></a>
## Implementation Roadmap

**Phase 1 — Immediate (this week): resource governance + security floor.**
The Top 10 list above, in order. Items 1–3 and 7 (memory bound, frame caps, backpressure, connection limits) close every externally-triggerable OOM path; 4 and 6 (timing-safe compares, fail-closed secrets) close the cheap security holes; 5 (loud `SET` option errors) removes the correctness time bomb; 8–9 (crash safety nets, saturation metrics) make failures visible and survivable; 10 (reproducible builds) locks the supply chain. Estimated effort: 2–4 focused days total; no design work required.

**Phase 2 — 3–6 months: operational maturity.**
- Incremental/sampled TTL sweep (remove the O(keyspace) periodic stall).
- Readiness/liveness split; readiness false on shutdown and sustained event-loop lag.
- Failed-`AUTH` throttling and disconnect.
- Slow-command log (>10 ms, redacted keys); alert rules on the new saturation gauges.
- Ops runbook (symptom → admin endpoint → confirming metric); document admin-port reachability.
- CI: `npm ci`, `npm audit`, image scan, build/push/deploy pipeline.
- Load test the two ceilings (pub/sub fan-out and write throughput) to replace guesses with numbers; publish the measured capacity envelope in the docs.

**Phase 3 — 6–12 months: evolution only where measured.**
- `Buffer`-based value storage (halve payload memory, drop latin1 round-trips) — do this before any capacity-driven resizing.
- Optional snapshot-on-shutdown/restore for planned redeploys (rate-limit continuity without HA complexity) — only if the restart fail-open window proves to matter.
- TLS on the RESP listener if compliance requires encrypted internal hops.
- Namespace-sharding playbook (second independent instance per use case) as the documented answer to capacity growth — explicitly *instead of* replication/clustering.
- Revisit single-replica only if BackendCache's own availability becomes a *measured* problem, per the existing architecture doc — that discipline is correct; keep it.

---

<a name="metrics"></a>
## Architecture Metrics

**Quantitative assessments:**

| Dimension | Score | Basis |
|---|---|---|
| Performance | **4/5** at target scale | Synchronous in-memory ops are µs-scale; single-loop ceiling is far above the consuming fleet's demand. Deduct for unmeasured fan-out ceiling and O(n) sweep. |
| Reliability | **2/5** today → 4/5 after Phase 1 | Excellent shutdown discipline and zero-dependency data plane, undermined by externally-triggerable OOM paths and no crash safety nets. |
| Security | **3/5** today → 4/5 after Phase 1 | Strong structure (network isolation, two-secret split, no scripting, anti-exfil admin design); loses points to fail-open secrets, timing-comparable checks, and pre-auth DoS surface. |
| Cost | **5/5** | ~$10–15/month for the isolation achieved; zero licenses; near-zero dependency maintenance. |
| Maintainability | **4/5** | Small, idiomatic, well-commented code; behavioral test strategy; documented non-goals. Deduct for the semantic-honesty inconsistency (`SET` options, `CLIENT` catch-all `+OK`). |

**Qualitative assessments:**
- *Fitness for purpose*: **High.** The architecture matches its problem with unusual precision, and — rarer — documents *why* the tempting generalizations were refused.
- *Future-proofing*: **Adequate by intent.** The design's future-proofing is its smallness: the coverage-audit fence and non-goals list are mechanisms that keep scope from rotting. The named evolution path (namespace sharding over clustering) is realistic.
- *Technical debt*: deliberate debt is documented and priced; the material undocumented debt is the missing resource-governance layer, fully covered by Phase 1. After that, debt posture is genuinely clean.
- *Team capability alignment*: TypeScript/Node matches the consuming team; no exotic operational skills (no cluster ops, no persistence tuning) required — that alignment is itself an architectural feature.
- *Innovation potential*: appropriately low — this is infrastructure that should be boring. The innovation already happened in the test strategy (correctness defined by real-client behavior), which is worth reusing as a pattern elsewhere.

**Bottom line.** This is a well-reasoned, well-documented system whose deliberate constraints are its strengths. Its one systemic weakness is that it currently trusts its (internal) network completely on resource consumption: nearly every high-severity finding in this review is a variation of "an unbounded thing needs a bound." The Top 10 list closes that class entirely in a few days of work, after which the architecture is sound for its stated mission.
