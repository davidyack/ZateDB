# Changelog

All notable changes to ZateDB are documented here. Versions are tagged
`vX.Y.Z` and published as immutable image/module artifacts (see
[infra/README.md](./infra/README.md)).

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
