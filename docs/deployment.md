# Deployment

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `RESP_PORT` | `6379` | RESP TCP listener |
| `HEALTH_PORT` | `8081` | `/healthz` |
| `ADMIN_PORT` | `8082` | Admin JSON API |
| `REDIS_AUTH_PASSWORD` | unset | RESP `AUTH` password; unset means no auth required |
| `ADMIN_TOKEN` | unset | Admin API bearer token; unset means the admin API relies on network isolation alone |
| `TTL_SWEEP_INTERVAL_MS` | `5000` | Active TTL sweep frequency |
| `MAX_KEYS` | `1000000` | Max distinct keys; a write creating a new key past this is rejected with `-OOM`. `0` disables |
| `MAX_MEMORY_BYTES` | `402653184` (384 MiB) | Estimated keyspace byte ceiling; new-key writes past this are rejected with `-OOM`. Keep it below the container memory limit so the app sheds load before the OOM-killer wipes all state. `0` disables |
| `MAX_CLIENTS` | `10000` | Max concurrent RESP connections; further connections are refused with `-ERR max number of clients reached`. `0` disables |
| `IDLE_TIMEOUT_MS` | `300000` (5 min) | Idle (no-traffic) non-subscriber connections are closed after this. Subscribers are exempt. `0` disables |
| `MAX_BULK_BYTES` | `8388608` (8 MiB) | Max declared length of a single RESP bulk string; a larger header is a protocol error |
| `MAX_BUFFER_BYTES` | `16777216` (16 MiB) | Max unparsed bytes buffered per connection before the connection is killed |
| `MAX_OUTBOUND_BUFFER_BYTES` | `33554432` (32 MiB) | Outbound socket buffer high-water mark; a slow consumer exceeding it is disconnected |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | unset | Enables the Azure Monitor OpenTelemetry exporter |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Enables plain OTLP HTTP export as an alternative to Azure Monitor |

### High availability (multi-node) configuration

See [High availability](./high-availability.md) for the architecture these enable — setting **both** a durable store and a replication transport switches the process from standalone (single-node) to HA (multi-node) mode; setting only one is a misconfiguration and falls back to standalone.

| Env var | Default | Purpose |
|---|---|---|
| `NODE_ID` | unset | This node's identity, used as its Service Bus subscription name and Cosmos DB heartbeat document id. Falls back to `CONTAINER_APP_REPLICA_NAME` (set automatically by Container Apps), then a random id. |
| `SERVICE_BUS_CONNECTION_STRING` | unset | Enables Service Bus-based cross-node replication via a SAS connection string. The policy needs **Manage** rights — each node creates/deletes its own subscription dynamically. Prefer managed identity (below) in production. |
| `SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE` | unset | Service Bus namespace host (e.g. `my-ns.servicebus.windows.net`) for managed-identity (AAD) auth, used when no connection string is set. The identity needs a role allowing topic manage + send/receive. Also accepts `SERVICE_BUS_NAMESPACE`. |
| `SERVICE_BUS_TOPIC_NAME` | `backendcache-replication` | Shared topic every node publishes to and subscribes from |
| `COSMOS_CONNECTION_STRING` | unset | Cosmos DB key-based auth. Takes precedence over `COSMOS_ENDPOINT`. |
| `COSMOS_ENDPOINT` | unset | Cosmos DB account endpoint, for managed-identity (AAD) auth when no connection string is set |
| `COSMOS_DATABASE` | `backendcache` | Database name — must already exist |
| `COSMOS_KEYS_CONTAINER` | `keys` | Container for key state, partitioned on `/key` — must already exist. Enable **`DefaultTimeToLive`** on it (e.g. `-1`, "on but no default") so Cosmos evicts expired keys via the per-document `ttl` and the container doesn't grow unbounded — see [High availability](./high-availability.md#operational-notes) |
| `COSMOS_NODES_CONTAINER` | `nodes` | Container for node heartbeat/topology snapshots, partitioned on `/nodeId` — must already exist |
| `HEARTBEAT_INTERVAL_MS` | `10000` | How often each node writes its stats/topology snapshot to Cosmos DB |
| `NODE_STALE_MS` | `30000` | A peer node's heartbeat older than this is dropped from cluster admin views |
| `ANTI_ENTROPY_INTERVAL_MS` | `300000` (5 min) | How often each node re-loads durable keys changed since its last pass, as a convergence backstop for replication events missed during a partition/blip. `0` disables — see [High availability](./high-availability.md#operational-notes) |
| `DURABILITY_MIN_TTL_MS` | `0` (off) | Cost lever: keys whose remaining TTL is under this at replication time skip the Cosmos write (peers still converge via Service Bus). Removes the dominant rate-limit-churn RU; the trade is that a *full-cluster* restart loses sub-threshold keys. A sensible enabled value is `60000` — see [High availability](./high-availability.md#cost) |
| `CLUSTER_STARTUP_TIMEOUT_MS` | `30000` | Maximum time connecting to Cosmos DB/Service Bus and hydrating may take before the process exits and lets Container Apps' restart policy retry — a stuck startup fails fast rather than leaving a replica alive but permanently not-ready |
| `REQUIRE_HA` | `false` | When `true`, refuse to start unless HA is fully configured (both Cosmos DB and Service Bus). Set in the multi-replica deployment so a partial or missing config crash-loops instead of silently running split-brain standalone nodes behind one load balancer. Leave unset for local/standalone use — see [High availability](./high-availability.md#standalone-mode) |
| `SHUTDOWN_HARD_LIMIT_MS` | `10000` | Hard ceiling on graceful shutdown. `cluster.stop()`'s network calls (replication drain, Service Bus subscription delete) hanging — especially on the crash path — would otherwise leave a zombie that never exits; this force-exits instead |
| `MAX_FAILED_AUTH_ATTEMPTS` | `5` | Consecutive failed `AUTH` attempts on one connection before it's dropped, forcing a full reconnect per burst of guesses to blunt line-speed password brute force. `0` disables |

A consuming application points its `REDIS_URL` at BackendCache exactly as
it would at real Redis — e.g. `redis://:<password>@backendcache:6379` —
with no other code changes beyond the
[rate-limit store deviation](./rate-limit-store.md).

## Running locally

```bash
npm install
npm run dev        # tsx watch, RESP on :6379, health on :8081, admin on :8082
```

## Docker

`Dockerfile` is a multi-stage build producing a minimal Node image that
exposes the RESP port (`6379`), health port (`8081`), and admin port
(`8082`). It installs the optional OpenTelemetry exporter packages
best-effort — the image build doesn't fail if that install has issues,
since telemetry is never a hard runtime dependency (see
[Observability](./observability.md)).

```bash
docker build -t backendcache:latest .
docker run -p 6379:6379 -p 8081:8081 -p 8082:8082 backendcache:latest
```

## Azure Container Apps

`infra/backendcache.bicep` is a deployment sketch for running BackendCache
as a multi-node Azure Container App with internal-only ingress, inside a
Container Apps Environment your infrastructure already provisions. It's
not a complete, standalone template — it assumes the surrounding
infrastructure (Container Apps Environment, container registry, managed
identity, Application Insights, an existing Service Bus namespace, an
existing Cosmos DB account/database/containers, and Key Vault secrets for
`REDIS_AUTH_PASSWORD`, `ADMIN_TOKEN`, the Service Bus connection string,
and the Cosmos DB connection string) is already in place.

Key properties of the sketch:

- `ingress.external = false` — no public IP, ever.
- `scale: { minReplicas: 2, maxReplicas: 5 }`, scaling on concurrent TCP
  connections — running multiple nodes is the point of this deployment;
  see [High availability](./high-availability.md).
- Liveness (`/healthz`) and readiness (`/readyz`) probes are split:
  readiness fails until this node has finished hydrating its in-memory
  copy from Cosmos DB, so a fresh replica is never routed a client before
  its cache is warm.
- `REDIS_AUTH_PASSWORD`, `ADMIN_TOKEN`, and the Service Bus/Cosmos DB
  connection strings are all pulled from Key Vault via a user-assigned
  managed identity, matching how this kind of infra usually already
  stores connection secrets.
- `NODE_ID` is deliberately left unset in the template — each node falls
  back to `CONTAINER_APP_REPLICA_NAME`, which Container Apps sets
  automatically and uniquely per replica.

This is strictly better network isolation than a managed Redis offering
reachable via VNet/Private Endpoints, since there is no public endpoint at
all.
