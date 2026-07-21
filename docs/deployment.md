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

See [High availability](./high-availability.md) for the architecture these enable — setting **both** a durable store and a replication transport switches the process from standalone (single-node) to HA (multi-node) mode; setting only one is a misconfiguration that **crashes at startup** (never a silent fallback). With no HA configured the process is a single node and the deployment must run exactly one replica — see [Standalone mode](./high-availability.md#standalone-mode).

| Env var | Default | Purpose |
|---|---|---|
| `NODE_ID` | unset | This node's identity, used as its Service Bus subscription name and Cosmos DB heartbeat document id. Falls back to `CONTAINER_APP_REPLICA_NAME` (set automatically by Container Apps), then a random id. |
| `SERVICE_BUS_CONNECTION_STRING` | unset | Enables Service Bus-based cross-node replication via a SAS connection string. The policy needs **Manage** rights — each node creates/deletes its own subscription dynamically. Prefer managed identity (below) in production. |
| `SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE` | unset | Service Bus namespace host (e.g. `my-ns.servicebus.windows.net`) for managed-identity (AAD) auth, used when no connection string is set. The identity needs a role allowing topic manage + send/receive. Also accepts `SERVICE_BUS_NAMESPACE`. |
| `SERVICE_BUS_TOPIC_NAME` | `zatedb-replication` | Shared topic every node publishes to and subscribes from |
| `COSMOS_CONNECTION_STRING` | unset | Cosmos DB key-based auth. Takes precedence over `COSMOS_ENDPOINT`. |
| `COSMOS_ENDPOINT` | unset | Cosmos DB account endpoint, for managed-identity (AAD) auth when no connection string is set |
| `COSMOS_DATABASE` | `zatedb` | Database name — must already exist |
| `COSMOS_KEYS_CONTAINER` | `keys` | Container for key state, partitioned on `/key` — must already exist. Enable **`DefaultTimeToLive`** on it (e.g. `-1`, "on but no default") so Cosmos evicts expired keys via the per-document `ttl` and the container doesn't grow unbounded — see [High availability](./high-availability.md#operational-notes) |
| `COSMOS_NODES_CONTAINER` | `nodes` | Container for node heartbeat/topology snapshots, partitioned on `/nodeId` — must already exist |
| `HEARTBEAT_INTERVAL_MS` | `10000` | How often each node writes its stats/topology snapshot to Cosmos DB |
| `NODE_STALE_MS` | `30000` | A peer node's heartbeat older than this is dropped from cluster admin views |
| `HEARTBEAT_TOP_SUBSCRIPTIONS` | `25` | Max channels/patterns (each) detailed in a heartbeat snapshot, by subscriber count, so the doc's per-write RU doesn't grow with Socket.IO room count. Totals stay exact; `0` keeps all |
| `ANTI_ENTROPY_INTERVAL_MS` | `300000` (5 min) | How often each node re-loads durable keys changed since its last pass, as a convergence backstop for replication events missed during a partition/blip. `0` disables — see [High availability](./high-availability.md#operational-notes) |
| `DURABILITY_MIN_TTL_MS` | `0` (off) | Cost lever: keys whose remaining TTL is under this at replication time skip the Cosmos write (peers still converge via Service Bus). Removes the dominant rate-limit-churn RU; the trade is that a *full-cluster* restart loses sub-threshold keys. A sensible enabled value is `60000` — see [High availability](./high-availability.md#cost) |
| `CLUSTER_STARTUP_TIMEOUT_MS` | `30000` | Maximum time connecting to Cosmos DB/Service Bus and hydrating may take before the process exits and lets Container Apps' restart policy retry — a stuck startup fails fast rather than leaving a replica alive but permanently not-ready |
| `REQUIRE_HA` | `false` | When `true`, refuse to start unless HA is fully configured (both Cosmos DB and Service Bus). Set in the multi-replica deployment so a partial or missing config crash-loops instead of silently running split-brain standalone nodes behind one load balancer. Leave unset for local/standalone use — see [High availability](./high-availability.md#standalone-mode) |
| `SHUTDOWN_HARD_LIMIT_MS` | `10000` | Hard ceiling on graceful shutdown. `cluster.stop()`'s network calls (replication drain, Service Bus subscription delete) hanging — especially on the crash path — would otherwise leave a zombie that never exits; this force-exits instead |
| `MAX_FAILED_AUTH_ATTEMPTS` | `5` | Consecutive failed `AUTH` attempts on one connection before it's dropped, forcing a full reconnect per burst of guesses to blunt line-speed password brute force. `0` disables |
| `SLOW_COMMAND_LOG_MS` | `0` (off) | Log any command taking at least this many ms (with a redacted key), for latency diagnosis. Commands are normally sub-millisecond, so a small value like `10` is high-signal; `0` disables |

A consuming application points its `REDIS_URL` at ZateDB exactly as
it would at real Redis — e.g. `redis://:<password>@zatedb:6379` —
with no code changes; even `rate-limit-redis`'s default store works via
[Lua support](./command-reference.md#lua-scripting) (an optional
lighter-weight store is described in
[The rate-limit store](./rate-limit-store.md)).

## Cosmos DB cost & sizing

Cosmos request units (RU) are the dominant marginal cost of the HA
architecture (see [High availability → Cost](./high-availability.md#cost)).
Three infra-level settings materially change the bill; none require code
changes.

### 1. Custom indexing policy on the `keys` container (biggest single lever)

Cosmos's **default** indexing policy indexes *every path in every
document* — every field of every presence hash, every member of every
sliding-window zset, every counter origin. Write RU scales with the number
of indexed paths, so the default makes each hash/zset patch and each upsert
pay to index data no query ever reads. The only paths the service queries
are `/key`, `/updatedAtMs`, and `/entry/expiresAtMs` (plus the
server-managed `/_ts`, which is always indexed). Set this policy on the
`keys` container — typically a **2–5× write-RU reduction** on
container-typed entries:

```json
{
  "indexingMode": "consistent",
  "automatic": true,
  "includedPaths": [
    { "path": "/key/?" },
    { "path": "/updatedAtMs/?" },
    { "path": "/entry/expiresAtMs/?" }
  ],
  "excludedPaths": [{ "path": "/*" }]
}
```

[`infra/modules/cosmos-resources.bicep`](../infra/modules/cosmos-resources.bicep)
applies this policy when it creates the container, so you get it by default.
If you bring your own container (`createCosmosContainers: false`), apply it
where that container is defined.

### 2. Capacity mode: serverless vs. provisioned

Pick from **measured** RU, not a guess (the `zatedb.cosmos.request_units`
metric exists for exactly this — see [Observability](./observability.md)):

- **Serverless** bills per request — wins at low or bursty sustained RU.
- **Provisioned throughput (autoscale)** bills for the high-water decile —
  wins once sustained average RU/s clears a few hundred.

After a representative week, pick, record the reasoning here, and add an
alert on RU-consumption slope so a keyspace or traffic regression shows up
as a cost signal rather than a surprise bill.

### 3. Persistence exemption for short-TTL keys

Set `DURABILITY_MIN_TTL_MS` (e.g. `60000`) to stop persisting rate-limit /
sliding-window churn that resets in seconds — see the env table above and
[High availability → Cost](./high-availability.md#cost). This is usually the
largest reduction in the *number* of durable writes.

### Right-sizing

Derive the threshold above, the capacity mode, replica count/size, and any
future durable-write-cadence throttle from a representative Socket.IO +
rate-limit load test with RU metering on. Publish the measured envelope
(RU per command class, replication lag under burst, node headroom) here so
the numbers are observed, not guessed.

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
docker build -t zatedb:latest .
docker run -p 6379:6379 -p 8081:8081 -p 8082:8082 zatedb:latest
```

## Azure Container Apps

`infra/modules/zatedb.bicep` runs ZateDB as a multi-node Azure Container App
with internal-only ingress. It's designed to be consumed as a module from a
consuming application's own Bicep: you pass the **names** of infrastructure
you already have, and the module creates everything ZateDB-specific inside
it — its own managed identity, its own replication topic, its own Cosmos
database and containers, and every role assignment those need.

```bicep
module zatedb 'modules/zatedb.bicep' = {
  name: 'zatedb'
  params: {
    namePrefix: 'contoso'
    managedEnvironmentId: containerAppsEnvironment.id
    containerImage: 'ghcr.io/davidyack/zatedb:abc123'
    serviceBusNamespaceName: serviceBus.name
    cosmosAccountName: cosmos.name
    authPassword: redisPassword
  }
}

// then, in your app:
{ name: 'REDIS_URL', value: 'redis://:${redisPassword}@${zatedb.outputs.hostAndPort}' }
```

The prerequisites are a Container Apps Environment, a Service Bus namespace,
a Cosmos DB account, an image, and a password. Everything else has a
default. `ghcr.io/davidyack/zatedb` is public, so no registry credential is
needed; pulling from a private Azure Container Registry instead means also
passing `containerRegistryName`, which makes the module grant its identity
`AcrPull`. See [`infra/README.md`](../infra/README.md) for the resource-group
and subscription overrides when those live elsewhere, the four "I already
have Cosmos" variants, and the permissions the deploying principal needs.
[`infra/examples/consumer-app.bicep`](../infra/examples/consumer-app.bicep)
is a complete worked example.

Key properties:

- `ingress.external = false` — no public IP, ever.
- `scale: { minReplicas: 2, maxReplicas: 5 }`, scaling on concurrent TCP
  connections — running multiple nodes is the point of this deployment;
  see [High availability](./high-availability.md).
- Liveness (`/healthz`) and readiness (`/readyz`) probes are split:
  readiness fails until this node has finished hydrating its in-memory
  copy from Cosmos DB, so a fresh replica is never routed a client before
  its cache is warm.
- Service Bus and Cosmos DB are reached with a user-assigned managed
  identity, never a connection string or account key — so there's no broad
  secret to store, leak, or rotate. The Cosmos grant is scoped to ZateDB's
  own database, so in a shared account it can't reach anything else you
  keep there.
- `REDIS_AUTH_PASSWORD` and `ADMIN_TOKEN` are `@secure()` parameters,
  since the consuming app needs the password anyway to build its own
  `REDIS_URL`. Key Vault secret URIs are accepted as an override for shops
  that require them.
- `NODE_ID` is deliberately left unset in the template — each node falls
  back to `CONTAINER_APP_REPLICA_NAME`, which Container Apps sets
  automatically and uniquely per replica.
- The Cosmos containers are created with `DefaultTimeToLive` and the
  restricted indexing policy already applied, so the cost guidance below is
  enforced by the template rather than left as a manual step.

This is strictly better network isolation than a managed Redis offering
reachable via VNet/Private Endpoints, since there is no public endpoint at
all.
