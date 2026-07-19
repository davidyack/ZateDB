# Security

- **No public ingress**: network exposure is the primary control
  (internal-only Container Apps ingress, or equivalent in your
  environment — see [Deployment](./deployment.md)).
- **`AUTH`** via `REDIS_AUTH_PASSWORD`, sent automatically by the `redis`
  client whenever `REDIS_URL` includes credentials — defense-in-depth even
  on a private network.
- **The admin API token is a separate secret** from the `AUTH` password,
  independently rotatable — different blast radius. The `AUTH` password
  lets a caller read/write cache data as the app would; the admin token
  lets a caller inspect and delete arbitrarily via the
  [admin surface](./observability.md#admin-api).
- **No `EVAL`/scripting support** means no arbitrary code execution
  surface — a structurally smaller attack surface than a general-purpose
  Redis-compatible engine, and a genuine security property of the
  "build only what we need" approach (see
  [Non-goals](./command-reference.md#non-goals)), not just a cost-cutting
  choice.
- **The admin `/admin/keys` list endpoint never returns values** — only
  key name, type, and TTL — specifically so a debugging tool can't double
  as a bulk-data-exfiltration surface even on an internal network. Fetching
  a single key's full value (`GET /admin/keys/:key`) is an explicit,
  targeted, logged action.
- **Every admin action is logged and emitted as a metric**
  (`backendcache.admin.actions.total`), and `DELETE` in particular is
  treated as auditable — it mutates state a real client depends on, not a
  side-effect-free debug read.
