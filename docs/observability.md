# Observability

## Admin API

A token-gated JSON API on its own port
([`src/http/adminServer.ts`](../src/http/adminServer.ts), `:8082` by
default — separate from the RESP port and `/healthz`), for
`curl`/support-tooling use. No UI.

Every request requires `Authorization: Bearer <ADMIN_TOKEN>`. If
`ADMIN_TOKEN` isn't set, the admin API relies on network isolation alone —
set it in any environment where the admin port is reachable by more than
trusted operators.

Any node can answer any admin request — Container Apps' internal ingress
has no way to target one specific replica. In standalone (single-node)
mode every endpoint reflects only this process; in HA (multi-node) mode,
`/admin/stats` and `/admin/pubsub` also report a cluster-wide view
assembled from every node's periodic heartbeat snapshot (see
[High availability](./high-availability.md#3-heartbeat)), and
`/admin/nodes` lists cluster membership directly.

| Endpoint | Method | Purpose |
|---|---|---|
| `/admin/stats` | GET | Uptime, connection count, key counts by type, subscription counts, command throughput, memory estimate — all for this node, plus a `cluster` object (node count, summed connections/commands/key counts, per-node heartbeat) when HA is enabled. |
| `/admin/keys?prefix=&limit=&offset=` | GET | Paginated key names + type + TTL, from this node's in-memory copy — deliberately does **not** return values by default, to avoid a debug endpoint becoming a bulk-data-exfiltration surface even on an internal network. |
| `/admin/keys/:key` | GET | Full detail (type, value/members, TTL) for one specific key — an explicit, targeted action for debugging a single stuck client, not a bulk dump. |
| `/admin/keys/:key` | DELETE | Manually clear a stuck key (e.g. unblock a wrongly rate-limited client). In HA mode this propagates cluster-wide via the same replication path a client's `DEL` uses, not just locally. Destructive — logged and emitted as a metric, not a silent debug tool. |
| `/admin/pubsub` | GET | Active channels/patterns with subscriber counts for this node. In HA mode, also a merged cluster-wide view and a per-node breakdown. Topology only, no message content. |
| `/admin/nodes` | GET | Cluster membership: every node with a live heartbeat (`nodeId`, last heartbeat, connection count, key counts, subscriptions), the queried node marked `self`. In standalone mode, just this node. |

## OpenTelemetry

Standard OpenTelemetry instrumentation
([`src/telemetry/`](../src/telemetry/)) — spans and metrics via
`@opentelemetry/api`, exported via the Azure Monitor exporter (when
`APPLICATIONINSIGHTS_CONNECTION_STRING` is set) or plain OTLP HTTP (when
`OTEL_EXPORTER_OTLP_*` endpoints are set). If neither is configured, or the
optional exporter packages aren't installed, telemetry degrades to the
`@opentelemetry/api` no-op provider — spans/metrics are still created but
cost nothing and go nowhere. Tracing must never be a hard runtime
dependency for a cache/pub-sub service, and the optional exporter packages
aren't guaranteed to install in every environment (see the ambient module
stubs in [`src/telemetry/optionalOtelModules.d.ts`](../src/telemetry/optionalOtelModules.d.ts),
which keep `tsc`/build from depending on whether they're present).

### Tracing

One span per command execution — not per connection, since a Socket.IO
adapter's subscriber connection can live for the process's entire
lifetime, and a span spanning hours is an anti-pattern. Span name:
`backendcache.command.<COMMAND>` (e.g. `backendcache.command.ZCOUNT`).

Attributes: `db.system = "backendcache"`, `db.operation = <COMMAND>`,
`backendcache.connection_id`, `backendcache.result = success|error`,
`backendcache.key` — a key is redacted (an 8-char prefix plus a short
hash suffix) before it lands in a span attribute, since a key name can
embed identifying data.

Connection open/close and subscribe/unsubscribe lifecycle transitions are
recorded as **span events** ([`src/telemetry/commandTelemetry.ts`](../src/telemetry/commandTelemetry.ts)),
not full spans — a Socket.IO adapter's subscriber connection can live for
the process's entire lifetime, and a span spanning hours is the same
anti-pattern either way:

- Subscribe/unsubscribe (`subscription.added` / `subscription.removed`)
  attach to the currently-active span, which is the `SUBSCRIBE`/
  `UNSUBSCRIBE` command's own span — a real, bounded operation already in
  progress.
- Connection open/close (`connection.opened` / `connection.closed`) have
  no such natural parent (a connection can sit open before its first
  command), so each gets its own near-zero-duration span carrying a
  single event — the idiomatic OTel shape for a bounded moment with
  nothing to attach to.

**Known limitation**: RESP has no header/metadata channel, so there's no
way to propagate a calling request's `traceparent` into a BackendCache
command span — BackendCache spans are self-contained, not children of the
originating request's trace. This is an accepted gap.

### Metrics

| Metric | Type | Dimensions |
|---|---|---|
| `backendcache.commands.total` | Counter | `command`, `result` |
| `backendcache.commands.duration_ms` | Histogram | `command` |
| `backendcache.connections.active` | UpDownCounter | — |
| `backendcache.pubsub.subscriptions.active` | UpDownCounter | `type` (channel/pattern) |
| `backendcache.admin.actions.total` | Counter | `action`, `result` |
| `backendcache.keys.count` | Observable gauge | `type` (string/hash/sortedset) — this node's live in-memory key count, sampled on export |
| `backendcache.cosmos.request_units` | Counter | `operation` (upsert/patch/query/delete) — Cosmos RU consumed, the dominant HA cost. Slope over time is the cost signal for capacity-mode/threshold decisions |
| `backendcache.servicebus.publishes` | Counter | — replication events published to the topic |
| `backendcache.replication.queue_depth` | Observable gauge | pending + in-flight replication tasks — where write back-pressure accumulates under bursts or a slow Cosmos |
| `backendcache.cluster.ha_enabled` | Observable gauge | — `1` when HA replication (Cosmos+Service Bus) is active, `0` when standalone. Alert on `0` joined with the platform's replica-count metric: >1 replica while this reads `0` is split-brain (a node can't detect siblings without the shared backend, so this is the in-process half of that signal) |
| `backendcache.scripts.evalsha.total` | Counter | `result` (`hit`/`noscript`) — a `noscript` spike means the per-node in-memory script cache was lost (restart) or an `EVALSHA` hit a node that never saw the `SCRIPT LOAD`; clients recover via `EVAL` |
| `backendcache.scripts.errors.total` | Counter | `phase` (`compile`/`runtime`) |
| `backendcache.scripts.cache.size` | Observable gauge | — Lua scripts held in this node's SHA1 cache |

### Prometheus `/metrics` endpoint

For environments that scrape rather than receive an OTLP push, the health
server (same port as `/healthz` and `/readyz`) also serves a
`GET /metrics` endpoint in Prometheus text exposition format
(`text/plain; version=0.0.4`). It's a self-contained pull surface that
lives *alongside* — not instead of — the OTLP/Azure Monitor push pipeline,
so a plain Prometheus server can scrape the core numbers without wiring up
an OTLP collector.

It is deliberately unauthenticated (like the health probes) and cheap:
every value is an already-tracked O(1) aggregate — no keyspace walk — and
no key names or values are ever exposed, only counts. Exposed families
(all prefixed `backendcache_`, rendered in
[`src/telemetry/prometheus.ts`](../src/telemetry/prometheus.ts)):

| Metric | Type | Labels |
|---|---|---|
| `backendcache_up` | gauge | — |
| `backendcache_uptime_seconds` | gauge | — |
| `backendcache_connected_clients` | gauge | — |
| `backendcache_commands_processed_total` | counter | — |
| `backendcache_keys` | gauge | `type` (string/hash/sortedset) |
| `backendcache_memory_estimate_bytes` | gauge | — |
| `backendcache_pubsub_channels` / `_patterns` | gauge | — |
| `backendcache_pubsub_channel_subscriptions` / `_pattern_subscriptions` | gauge | — |
| `backendcache_ha_enabled` | gauge | — (1 in HA, 0 standalone) |
| `backendcache_hydrated` | gauge | — |
| `backendcache_build_info` | gauge | `version`, `node_id` (value always 1) |

### Logs

Structured JSON logs to stdout/stderr
([`src/logger.ts`](../src/logger.ts)) for connection open/close, command
errors, TTL sweep activity, every admin action, and cluster lifecycle
events (hydration, heartbeat failures, replication failures, Service Bus
subscription setup/teardown). Kept lightweight — BackendCache is
infrastructure, not an agent with its own observability conventions.
