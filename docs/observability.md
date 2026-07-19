# Observability

## Admin API

A token-gated JSON API on its own port
([`src/http/adminServer.ts`](../src/http/adminServer.ts), `:8082` by
default — separate from the RESP port and `/healthz`), for
`curl`/support-tooling use. No UI in v1.

Every request requires `Authorization: Bearer <ADMIN_TOKEN>`. If
`ADMIN_TOKEN` isn't set, the admin API relies on network isolation alone —
set it in any environment where the admin port is reachable by more than
trusted operators.

| Endpoint | Method | Purpose |
|---|---|---|
| `/admin/stats` | GET | Uptime, connection count, key counts by type, subscription counts, command throughput, memory estimate. |
| `/admin/keys?prefix=&limit=&offset=` | GET | Paginated key names + type + TTL — deliberately does **not** return values by default, to avoid a debug endpoint becoming a bulk-data-exfiltration surface even on an internal network. |
| `/admin/keys/:key` | GET | Full detail (type, value/members, TTL) for one specific key — an explicit, targeted action for debugging a single stuck client, not a bulk dump. |
| `/admin/keys/:key` | DELETE | Manually clear a stuck key (e.g. unblock a wrongly rate-limited client). Destructive — logged and emitted as a metric, not a silent debug tool. |
| `/admin/pubsub` | GET | Active channels/patterns with subscriber counts. Topology only, no message content. |

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

Connection open/close and subscribe/unsubscribe are structured log lines,
not spans — they're lifecycle markers on a long-lived object, not bounded
operations.

**Known limitation**: RESP has no header/metadata channel, so there's no
way to propagate a calling request's `traceparent` into a BackendCache
command span — BackendCache spans are self-contained, not children of the
originating request's trace. This is an accepted v1 gap.

### Metrics

| Metric | Type | Dimensions |
|---|---|---|
| `backendcache.commands.total` | Counter | `command`, `result` |
| `backendcache.commands.duration_ms` | Histogram | `command` |
| `backendcache.connections.active` | UpDownCounter | — |
| `backendcache.pubsub.subscriptions.active` | UpDownCounter | `type` (channel/pattern) |
| `backendcache.admin.actions.total` | Counter | `action`, `result` |

### Logs

Structured JSON logs to stdout/stderr
([`src/logger.ts`](../src/logger.ts)) for connection open/close, command
errors, TTL sweep activity, and every admin action. Kept lightweight —
BackendCache is infrastructure, not an agent with its own observability
conventions.
