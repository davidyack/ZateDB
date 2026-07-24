# Changelog

All notable changes to ZateDB are documented here. Versions are tagged
`vX.Y.Z` and published as immutable image/module artifacts (see
[infra/README.md](./infra/README.md)).

## Unreleased

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
