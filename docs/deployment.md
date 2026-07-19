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
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | unset | Enables the Azure Monitor OpenTelemetry exporter |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Enables plain OTLP HTTP export as an alternative to Azure Monitor |

### High availability (multi-node) configuration

See [High availability](./high-availability.md) for the architecture these enable — setting **both** a durable store and a replication transport switches the process from standalone (single-node) to HA (multi-node) mode; setting only one is a misconfiguration and falls back to standalone.

| Env var | Default | Purpose |
|---|---|---|
| `NODE_ID` | unset | This node's identity, used as its Service Bus subscription name and Cosmos DB heartbeat document id. Falls back to `CONTAINER_APP_REPLICA_NAME` (set automatically by Container Apps), then a random id. |
| `SERVICE_BUS_CONNECTION_STRING` | unset | Enables Service Bus-based cross-node replication. The Shared Access Policy needs **Manage** rights — each node creates/deletes its own subscription dynamically. |
| `SERVICE_BUS_TOPIC_NAME` | `backendcache-replication` | Shared topic every node publishes to and subscribes from |
| `COSMOS_CONNECTION_STRING` | unset | Cosmos DB key-based auth. Takes precedence over `COSMOS_ENDPOINT`. |
| `COSMOS_ENDPOINT` | unset | Cosmos DB account endpoint, for managed-identity (AAD) auth when no connection string is set |
| `COSMOS_DATABASE` | `backendcache` | Database name — must already exist |
| `COSMOS_KEYS_CONTAINER` | `keys` | Container for key state, partitioned on `/key` — must already exist |
| `COSMOS_NODES_CONTAINER` | `nodes` | Container for node heartbeat/topology snapshots, partitioned on `/nodeId` — must already exist |
| `HEARTBEAT_INTERVAL_MS` | `10000` | How often each node writes its stats/topology snapshot to Cosmos DB |
| `NODE_STALE_MS` | `30000` | A peer node's heartbeat older than this is dropped from cluster admin views |
| `CLUSTER_STARTUP_TIMEOUT_MS` | `30000` | Maximum time connecting to Cosmos DB/Service Bus and hydrating may take before the process exits and lets Container Apps' restart policy retry — a stuck startup fails fast rather than leaving a replica alive but permanently not-ready |

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
