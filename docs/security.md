# Security

- **No public ingress**: network exposure is the primary control
  (internal-only Container Apps ingress, or equivalent in your
  environment — see [Deployment](./deployment.md)).
- **`AUTH`** via `REDIS_AUTH_PASSWORD`, sent automatically by the `redis`
  client whenever `REDIS_URL` includes credentials — defense-in-depth even
  on a private network. The password compare is timing-safe, and a
  connection that fails `AUTH` `MAX_FAILED_AUTH_ATTEMPTS` times in a row
  (default 5) is dropped, so a brute-force attempt pays a full TCP
  reconnect + handshake per burst instead of firing unlimited guesses down
  one socket at line speed. The failure reply is generic (it never hints
  how close a guess was).
- **The admin API token is a separate secret** from the `AUTH` password,
  independently rotatable — different blast radius. The `AUTH` password
  lets a caller read/write cache data as the app would; the admin token
  lets a caller inspect and delete arbitrarily via the
  [admin surface](./observability.md#admin-api). In HA mode, a `DELETE`
  through the admin API propagates cluster-wide, so the admin token's
  blast radius is the whole cluster, not just the node answering the
  request.
- **The Service Bus and Cosmos DB connection strings are separate secrets
  again**, pulled from Key Vault the same way as `REDIS_AUTH_PASSWORD`/
  `ADMIN_TOKEN` (see [`infra/backendcache.bicep`](../infra/backendcache.bicep)).
  The Service Bus policy needs Manage rights (to create/delete its own
  subscription per node), which is a wider grant than Send/Listen alone —
  scope it to a dedicated policy on the replication topic, not a
  namespace-root policy shared with unrelated queues/topics.
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
