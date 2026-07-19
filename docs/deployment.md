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
as a single-replica Azure Container App with internal-only ingress, inside
a Container Apps Environment your infrastructure already provisions. It's
not a complete, standalone template — it assumes the surrounding
infrastructure (Container Apps Environment, container registry, managed
identity, Application Insights, Key Vault secrets for `REDIS_AUTH_PASSWORD`
and `ADMIN_TOKEN`) is already in place.

Key properties of the sketch:

- `ingress.external = false` — no public IP, ever.
- `scale: { minReplicas: 1, maxReplicas: 1 }` — deliberately not
  autoscaled; see [Architecture: why single-replica](./architecture.md#why-single-replica).
- Liveness and readiness probes both point at `/healthz`.
- `REDIS_AUTH_PASSWORD` and `ADMIN_TOKEN` are pulled from Key Vault via a
  user-assigned managed identity, matching how this kind of infra usually
  already stores connection secrets.

This is strictly better network isolation than a managed Redis offering
reachable via VNet/Private Endpoints, since there is no public endpoint at
all.
