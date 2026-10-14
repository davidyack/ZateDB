# Changelog

All notable changes to ZateDB are documented here. Versions are tagged
`vX.Y.Z` and published as immutable image/module artifacts (see
[infra/README.md](./infra/README.md)).

## Unreleased

## 0.1.2

- **New: `HMGET`** — one reply per requested field, nil for missing
  fields/keys (`false` in Lua). Read-only; callable from `redis.call`.
  Unblocks the shared token-bucket rate-limit script, which was failing with
  `ERR Unknown Redis command called from script`.
- **New: `HINCRBYFLOAT`** — signed, fractional hash-field increment, reply
  formatted like Redis (no exponent, no trailing zeros, ≤17 significant
  digits); callable from `redis.call`. In HA it replicates as a per-node
  PN-counter (separate grow-only credit and debit totals per node, merged by
  max), so concurrent debits on different nodes add up instead of the last
  field write winning — in memory and in Cosmos DB. New replication event
  kind `hashFieldIncrement` and an optional `counters` property on durable
  hash documents; nodes must all run this version before the command is used
  (an older node drops the unknown event kind).
- **New: TCP keepalive on RESP connections** (`TCP_KEEPALIVE_MS`, default
  30 s) so stateful NAT/load balancers don't silently reap idle sockets.
- **New: idle-subscriber heartbeat** (`SUBSCRIBER_HEARTBEAT_INTERVAL_MS`,
  default 60 s): an idle pub/sub connection gets a harmless message frame
  on a reserved channel, so Azure Container Apps' envoy ingress doesn't drop
  it after its 5-minute idle timeout (TCP keepalive alone doesn't reset it).
- The Bicep module's `containerImage` default now tracks its own release
  (`ghcr.io/davidyack/zatedb:0.1.2`). Note: the `v0.1.1` module still
  defaulted to the `0.1.0` image, which has the `@azure/cosmos` crash below —
  consumers of module `0.1.1` should move to `0.1.2` or pin `containerImage`.

## 0.1.1

- **Fix: HA startup crash `Cannot find package '@azure/cosmos'` in the
  published images** (`:edge`, `:0.1.0`). The Azure SDK's transitive core
  packages (`@azure/core-util` et al.) declare `engines.node >= 22`, and npm
  silently skips *optional* dependencies that fail the engine check — so the
  Node 20 base image's `npm ci --omit=dev` quietly omitted the entire
  `@azure/*` tree (and would do the same to the OTel exporters). The base
  image is now Node 22 (`node:22.23.1-slim`), CI runs Node 22, `engines.node`
  is `>=22`, and the Dockerfile gained a build-time smoke check that imports
  every declared optionalDependency so a silently-skipped package fails the
  image build instead of shipping.

## 0.1.0

First tagged release. Establishes the two published artifacts consumers pin
against going forward:

- Container image: `ghcr.io/davidyack/zatedb:0.1.0` (also `:latest`),
  replacing the previous private-ACR build step — `containerImage` in
  `infra/modules/zatedb.bicep` now defaults to this tag.
- Bicep module: `br:ghcr.io/davidyack/zatedb/main:0.1.0` (also `:latest`),
  compiled from `infra/modules/zatedb.bicep` with its local module
  references (`cosmos-resources.bicep`, `servicebus-resources.bicep`,
  `acr-pull.bicep`) inlined — no vendoring required.

Everything else — the RESP-compatible cache/pub-sub service itself, the HA
architecture, and the full env-var contract — predates this tag; see
[README.md](./README.md) and [docs/](./docs) for what it does.
