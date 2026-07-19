// Deployment sketch for BackendCache as a multi-node (HA) Azure Container
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

@description('Container image, e.g. <registry>.azurecr.io/backendcache:<tag>')
param containerImage string

@description('User-assigned managed identity resource ID used to pull secrets from Key Vault')
param identityId string

@description('Key Vault secret URI for the RESP AUTH password')
param redisAuthSecretUri string

@description('Key Vault secret URI for the admin API bearer token')
param adminTokenSecretUri string

@description('Key Vault secret URI for the Service Bus connection string. The referenced Shared Access Policy needs Manage rights (not just Send/Listen) — each node creates its own subscription dynamically at startup, see docs/high-availability.md.')
param serviceBusConnectionStringSecretUri string

@description('Key Vault secret URI for the Cosmos DB connection string')
param cosmosConnectionStringSecretUri string

@description('Cosmos DB database name — must already exist')
param cosmosDatabaseName string = 'backendcache'

@description('Cosmos DB container for key state, partitioned on /key — must already exist')
param cosmosKeysContainerName string = 'keys'

@description('Cosmos DB container for node heartbeat/topology snapshots, partitioned on /nodeId — must already exist')
param cosmosNodesContainerName string = 'nodes'

@description('Service Bus topic name every node publishes/subscribes to for replication — created on demand if missing')
param serviceBusTopicName string = 'backendcache-replication'

@description('Application Insights connection string')
param appInsightsConnectionString string

@description('Minimum replica count. HA requires at least 2 so a single node restarting or being recycled never drops the service to zero.')
@minValue(2)
param minReplicas int = 2

@description('Maximum replica count for autoscale')
param maxReplicas int = 5

resource backendCacheApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-backendcache'
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
      secrets: [
        { name: 'redis-auth', keyVaultUrl: redisAuthSecretUri, identity: identityId }
        { name: 'admin-token', keyVaultUrl: adminTokenSecretUri, identity: identityId }
        { name: 'service-bus-connection-string', keyVaultUrl: serviceBusConnectionStringSecretUri, identity: identityId }
        { name: 'cosmos-connection-string', keyVaultUrl: cosmosConnectionStringSecretUri, identity: identityId }
      ]
    }
    template: {
      containers: [
        {
          name: 'backendcache'
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
            // NODE_ID is deliberately left unset: cluster/nodeId.ts falls
            // back to CONTAINER_APP_REPLICA_NAME, which Container Apps sets
            // automatically and uniquely per replica.
            { name: 'SERVICE_BUS_CONNECTION_STRING', secretRef: 'service-bus-connection-string' }
            { name: 'SERVICE_BUS_TOPIC_NAME', value: serviceBusTopicName }
            { name: 'COSMOS_CONNECTION_STRING', secretRef: 'cosmos-connection-string' }
            { name: 'COSMOS_DATABASE', value: cosmosDatabaseName }
            { name: 'COSMOS_KEYS_CONTAINER', value: cosmosKeysContainerName }
            { name: 'COSMOS_NODES_CONTAINER', value: cosmosNodesContainerName }
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

output backendCacheFqdn string = backendCacheApp.properties.configuration.ingress.fqdn
