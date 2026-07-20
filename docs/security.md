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
  [admin surface](/docs/observability.md#admin-api). In HA mode, a `DELETE`
  through the admin API propagates cluster-wide, so the admin token's
  blast radius is the whole cluster, not just the node answering the
  request.
- **The Azure data dependencies authenticate with managed identity, not
  connection strings.** The Bicep wires `COSMOS_ENDPOINT` +
  `SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE` and the app uses
  `DefaultAzureCredential` (the code supports a connection string / account
  key as a fallback for local dev, but production ships neither). That
  keeps the only Key Vault secrets the two *application*-level ones
  (`REDIS_AUTH_PASSWORD`, `ADMIN_TOKEN`) — nothing granting broad account
  access. Grant the identity least-privilege data-plane roles: the Cosmos
  DB data-contributor role on the one account, and a Service Bus role that
  allows topic manage + send/receive (each node creates/deletes its own
  subscription at startup) scoped to the one namespace/topic, not a
  namespace-root grant shared with unrelated queues/topics.
- **The replication topic is inside the data-plane trust boundary.** Any
  principal that can *send* to the Service Bus topic can inject
  `upsert`/`delete`/`ttl`/`increment`/`publish` events into every node's
  in-memory copy — replicated applies deliberately bypass admission control
  (a peer already accepted the write). Inbound events are **shape- and
  size-validated** before they're applied (`validateReplicationEvent`:
  kind-discriminated, typed per field, arrays and strings bounded well above
  any legitimate value), so a buggy or compromised publisher can't inject a
  malformed or absurdly-large event straight into memory — a
  defense-in-depth layer on top of the RBAC scoping. The topic is still
  reachable only by the cluster's own managed identity on an internal
  network; treat Send rights on it as equivalent to write access to the
  whole keyspace and scope them accordingly.
- **Short-TTL keys never reach durable storage.** With the persistence
  exemption on (`DURABILITY_MIN_TTL_MS`), rate-limit / sliding-window keys
  that expire within the threshold are replicated only in-memory and over
  Service Bus, never written to Cosmos — a minor but real reduction in
  data-at-rest exposure for the highest-churn, most-identifying keys.
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
  (`zatedb.admin.actions.total`), and `DELETE` in particular is
  treated as auditable — it mutates state a real client depends on, not a
  side-effect-free debug read.
