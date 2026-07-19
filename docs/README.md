# BackendCache docs

Deeper reference material than the top-level [README](../README.md), which
stays focused on a quickstart. Start here if you need the "why" behind a
design choice, not just the "how".

- [Architecture](./architecture.md) — transport, storage, pub/sub, shutdown, and why BackendCache runs as a single replica.
- [Command reference](./command-reference.md) — every supported command, plus the non-goals and why each was excluded.
- [The rate-limit store deviation](./rate-limit-store.md) — the one place a consuming app needs a small code change.
- [Deployment](./deployment.md) — configuration, running locally, Docker, and the Container Apps Bicep sketch.
- [Observability](./observability.md) — the admin API, OpenTelemetry tracing/metrics, and logging.
- [Testing](./testing.md) — the testing strategy and the command coverage audit script.
- [Security](./security.md) — the threat model and controls.
