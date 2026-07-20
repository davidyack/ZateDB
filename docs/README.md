# ZateDB docs

Deeper reference material than the top-level [README](../README.md), which
stays focused on a quickstart. Start here if you need the "why" behind a
design choice, not just the "how".

- [Architecture](./architecture.md) — a single node's transport, storage, pub/sub, and shutdown.
- [High availability](./high-availability.md) — running as multiple nodes: Service Bus replication, Cosmos DB persistence, hydration, and the consistency model.
- [Command reference](./command-reference.md) — every supported command, plus the non-goals and why each was excluded.
- [The rate-limit store](./rate-limit-store.md) — the default `rate-limit-redis` store works via Lua; an optional lighter-weight `INCR`-based store is also provided.
- [Deployment](./deployment.md) — configuration, running locally, Docker, and the Container Apps Bicep sketch.
- [Observability](./observability.md) — the admin API, OpenTelemetry tracing/metrics, and logging.
- [Operations runbook](./runbook.md) — incident-time diagnostics: admin-port access, "is replication flowing", hydration/durability semantics, cost health, and suggested alerts.
- [Testing](./testing.md) — the testing strategy and the command coverage audit script.
- [Security](./security.md) — the threat model and controls.
