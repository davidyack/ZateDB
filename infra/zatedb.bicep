// Deployment sketch for ZateDB as a multi-node (HA) Azure Container
// App, internal-only ingress, inside a Container Apps Environment the
// consuming app's infrastructure already provisions. Not a complete,
// standalone template — it assumes `containerEnv`, `acr`, `appIdentity`,
// `appInsights`, an existing Service Bus namespace, and an existing Cosmos
// DB account/database/containers are defined/passed in from the
// surrounding infra. See docs/high-availability.md for the architecture
// this maps to and docs/deployment.md for the full configuration surface.

@description('Name prefix for resources in this deployment')
param namePrefix string

@description('Location for all resources')
param location string = resourceGroup().location

@description('Resource ID of the existing Container Apps Environment')
param managedEnvironmentId string

@description('Container image, e.g. <registry>.azurecr.io/zatedb:<tag>')
param containerImage string

@description('User-assigned managed identity resource ID used to pull secrets from Key Vault and authenticate to Service Bus / Cosmos DB')
param identityId string

@description('Client (application) ID of the user-assigned managed identity above. Exported as AZURE_CLIENT_ID so DefaultAzureCredential selects this identity for Service Bus / Cosmos DB AAD auth rather than guessing among any others attached.')
param identityClientId string

@description('Key Vault secret URI for the RESP AUTH password')
param redisAuthSecretUri string

@description('Key Vault secret URI for the admin API bearer token')
param adminTokenSecretUri string

@description('Service Bus fully-qualified namespace host, e.g. my-ns.servicebus.windows.net. The app authenticates with its managed identity (no connection string / SAS key). Grant that identity a role with topic manage + send/receive (e.g. Azure Service Bus Data Owner) scoped to this namespace/topic — each node creates its own subscription dynamically at startup, see docs/high-availability.md.')
param serviceBusFullyQualifiedNamespace string

@description('Cosmos DB account endpoint, e.g. https://my-acct.documents.azure.com:443/. The app authenticates with its managed identity (no account key). Grant that identity the Cosmos DB data-plane role (e.g. Cosmos DB Built-in Data Contributor) on this account.')
param cosmosEndpoint string

@description('Cosmos DB database name — must already exist')
param cosmosDatabaseName string = 'zatedb'

@description('Cosmos DB container for key state, partitioned on /key — must already exist. Enable DefaultTimeToLive on it (e.g. -1) so Cosmos evicts expired keys via each document\'s ttl. Also set a custom indexing policy that indexes only /key, /updatedAtMs, /entry/expiresAtMs and excludes /* — the default indexes every hash field and zset member, multiplying write RU several-fold. See docs/deployment.md (Cosmos DB cost & sizing).')
param cosmosKeysContainerName string = 'keys'

@description('Cosmos DB container for node heartbeat/topology snapshots, partitioned on /nodeId — must already exist. Enable DefaultTimeToLive on it (e.g. -1) so a crashed node\'s heartbeat doc self-expires via its per-document ttl (~2x NODE_STALE_MS) instead of lingering.')
param cosmosNodesContainerName string = 'nodes'

@description('Service Bus topic name every node publishes/subscribes to for replication — created on demand if missing')
param serviceBusTopicName string = 'zatedb-replication'

@description('Application Insights connection string')
param appInsightsConnectionString string

@description('Minimum replica count. HA requires at least 2 so a single node restarting or being recycled never drops the service to zero.')
@minValue(2)
param minReplicas int = 2

@description('Maximum replica count for autoscale')
param maxReplicas int = 5

@description('Skip the Cosmos write for keys whose remaining TTL is under this (ms); peers still converge over Service Bus. 60s removes the dominant rate-limit/sliding-window RU. 0 persists everything. See docs/high-availability.md#cost.')
param durabilityMinTtlMs int = 60000

resource zateDbApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-zatedb'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironmentId
    configuration: {
      ingress: {
        external: false
        targetPort: 6379
        transport: 'tcp'
      }
      // Only the two application-level secrets (RESP AUTH password, admin
      // token) live in Key Vault. The Azure data dependencies (Service Bus,
      // Cosmos DB) use managed identity instead of connection strings/keys —
      // no broad secret to store, leak, or rotate.
      secrets: [
        { name: 'redis-auth', keyVaultUrl: redisAuthSecretUri, identity: identityId }
        { name: 'admin-token', keyVaultUrl: adminTokenSecretUri, identity: identityId }
      ]
    }
    template: {
      containers: [
        {
          name: 'zatedb'
          image: containerImage
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
            { name: 'REDIS_AUTH_PASSWORD', secretRef: 'redis-auth' }
            { name: 'ADMIN_TOKEN', secretRef: 'admin-token' }
            { name: 'RESP_PORT', value: '6379' }
            { name: 'HEALTH_PORT', value: '8081' }
            { name: 'ADMIN_PORT', value: '8082' }
            // At minReplicas >= 2, a partial/missing HA config must never
            // silently fall back to standalone: that would put several
            // independent, non-replicating nodes behind one load balancer
            // (split-brain, divergent per-connection keyspaces). REQUIRE_HA
            // makes that a hard startup failure so the restart policy
            // surfaces it loudly. See docs/high-availability.md.
            { name: 'REQUIRE_HA', value: 'true' }
            // NODE_ID is deliberately left unset: cluster/nodeId.ts falls
            // back to CONTAINER_APP_REPLICA_NAME, which Container Apps sets
            // automatically and uniquely per replica.
            // Managed-identity auth: the app reads these namespace/endpoint
            // hosts and authenticates via DefaultAzureCredential (the
            // user-assigned identity above), not a SAS key / account key.
            // AZURE_CLIENT_ID pins which identity DefaultAzureCredential uses.
            { name: 'AZURE_CLIENT_ID', value: identityClientId }
            { name: 'SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE', value: serviceBusFullyQualifiedNamespace }
            { name: 'SERVICE_BUS_TOPIC_NAME', value: serviceBusTopicName }
            { name: 'COSMOS_ENDPOINT', value: cosmosEndpoint }
            { name: 'COSMOS_DATABASE', value: cosmosDatabaseName }
            { name: 'COSMOS_KEYS_CONTAINER', value: cosmosKeysContainerName }
            { name: 'COSMOS_NODES_CONTAINER', value: cosmosNodesContainerName }
            // Cost: don't persist keys that expire within a minute
            // (rate-limit / sliding-window churn — the dominant write rate).
            // Peers still converge over Service Bus; the trade is that a
            // full-cluster restart loses sub-threshold keys, which reset in
            // seconds anyway. See docs/high-availability.md#cost.
            { name: 'DURABILITY_MIN_TTL_MS', value: string(durabilityMinTtlMs) }
          ]
          probes: [
            {
              // Liveness never gates on hydration — a node mid-hydration is
              // alive, just not ready for traffic yet (see the readiness
              // probe below).
              type: 'Liveness'
              httpGet: { port: 8081, path: '/healthz' }
              periodSeconds: 15
            }
            {
              // Readiness fails (503) until this node has finished loading
              // its in-memory copy from Cosmos DB, so Container Apps never
              // routes a client to a node serving a cold cache right after
              // scale-out or a restart. See src/http/healthServer.ts.
              type: 'Readiness'
              httpGet: { port: 8081, path: '/readyz' }
              periodSeconds: 5
            }
          ]
        }
      ]
      // Multiple replicas is the point of this deployment: each one holds
      // its own in-memory hot copy and stays in sync via Service Bus +
      // Cosmos DB (see docs/high-availability.md), so losing any single
      // replica to a restart, redeploy, or scale-down event doesn't drop
      // shared counters/presence/sliding-window state. Scaling on
      // concurrent TCP connections, since that's the actual load driver
      // for a RESP-protocol service (CPU/memory scaling would under-react
      // to a connection-count spike with a low per-command cost).
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'tcp-connections'
            tcp: {
              metadata: {
                concurrentConnections: '200'
              }
            }
          }
        ]
      }
    }
  }
}

output zateDbFqdn string = zateDbApp.properties.configuration.ingress.fqdn
