# Deploying ZateDB with Bicep

`modules/zatedb.bicep` is meant to be consumed as a module from your
application's own Bicep. You pass the **names** of infrastructure you already
have; the module creates everything ZateDB-specific inside it — its own
managed identity, replication topic, Cosmos database and containers, and every
role assignment those need.

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

`examples/consumer-app.bicep` is a complete worked version of the above.

## What you need first

| Thing | Why |
|---|---|
| Container Apps Environment | ZateDB runs in it, and **your app must run in the same one** — internal ingress is environment-scoped, so nothing outside it can reach ZateDB at all |
| Service Bus namespace | Cross-node replication. The module adds its own topic |
| Cosmos DB account (NoSQL API) | Durable store. The module adds its own database and containers |
| A container image | `ghcr.io/davidyack/zatedb` is published publicly on every merge to `main`, so no registry credential is needed. To pull from a private Azure Container Registry instead, build and push `Dockerfile` yourself and also pass `containerRegistryName` — the module then grants its identity `AcrPull` |
| A RESP password | You need the value anyway to build your app's `REDIS_URL`, so it's an input rather than something the module generates — Bicep outputs aren't secure and couldn't hand it back safely |

Everything else has a default.

## If you already have Cosmos

This is the common case and it's the default path — the module creates a
**dedicated `zatedb` database inside your existing account**, and scopes the
data-plane grant to `/dbs/zatedb`. ZateDB's identity can read and write its
own two containers and nothing else you keep in that account.

| What you have | Params |
|---|---|
| An account | `cosmosAccountName` — that's it |
| An account in another resource group | `+ cosmosResourceGroupName`, `cosmosSubscriptionId` |
| A database you want reused | `+ cosmosDatabaseName`, `createCosmosDatabase: false` |
| Database and containers already created | `+ createCosmosContainers: false` |

The same `*ResourceGroupName` / `*SubscriptionId` pattern applies to the
Service Bus namespace and the container registry.

A dedicated database is the default deliberately: if you point ZateDB at an
existing database that has **database-level provisioned throughput**, its two
containers compete with your application's containers for the same RU/s pool,
and rate-limit traffic is bursty.

### If you bring your own containers

With `createCosmosContainers: false` the module only grants access — it can't
retrofit these, and the first three aren't preferences, they're correctness:

- `keys` partitioned on `/key`; `nodes` partitioned on `/nodeId`
- `DefaultTimeToLive` enabled (e.g. `-1`) on both, so Cosmos evicts expired
  keys via each document's `ttl` and the containers don't grow unbounded
- An indexing policy on `keys` limited to `/key`, `/updatedAtMs`, and
  `/entry/expiresAtMs`, excluding `/*`

That last one is a cost setting, not a correctness one, but it's the single
biggest RU lever — the default policy indexes every field of every presence
hash and every member of every sliding-window zset, none of which is ever
queried. Typically a 2–5× write-RU reduction. See
[Cosmos DB cost & sizing](../docs/deployment.md#cosmos-db-cost--sizing).

## Permissions the deploying principal needs

Because the module writes into resource groups that may not be its own:

- On the **Cosmos** resource group: `Microsoft.DocumentDB/databaseAccounts/sqlDatabases/*/write`
  and `sqlRoleAssignments/write`. Cosmos data-plane access is granted through
  `sqlRoleAssignments`, *not* normal Azure RBAC — this is the step most hand-rolled
  deployments miss, and it surfaces as a 403 during hydration rather than at deploy time.
- On the **Service Bus** and **registry** resource groups:
  `Microsoft.Authorization/roleAssignments/write` (i.e. Owner or User Access
  Administrator), plus topic write.

## Tuning

Everything else is optional and lives in one typed object, so unset knobs keep
the application default documented in
[docs/deployment.md](../docs/deployment.md) rather than being pinned in two
places:

```bicep
tuning: {
  minReplicas: 3
  durabilityMinTtlMs: 60000
  extraEnv: [
    { name: 'SLOW_COMMAND_LOG_MS', value: '10' }
  ]
}
```

`extraEnv` covers any environment variable not surfaced as a named property.

## Notes

- `minReplicas` defaults to 2 and can't go lower — HA is the point of this
  deployment, and a single replica restarting would drop shared state.
- The module sets `REQUIRE_HA=true`, which is safe precisely because it always
  provisions both halves of the HA config. A partial config crash-loops loudly
  instead of silently running split-brain standalone nodes behind one load
  balancer.
- Scaling is on concurrent TCP connections, not CPU — that's the actual load
  driver for a RESP service.
- Secrets go inline as `@secure()` params by default. If your org requires
  Key Vault, pass `authPasswordSecretUri` / `adminTokenSecretUri` instead and
  grant the module's identity (`zatedb.outputs.principalId`) access at your
  vault.
