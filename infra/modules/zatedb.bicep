// ZateDB as a multi-node (HA) Azure Container App with internal-only
// ingress, meant to be consumed as a module from an application's own Bicep.
//
// The contract is deliberately narrow: you pass the *names* of infrastructure
// you already have (Container Apps Environment, Service Bus namespace, Cosmos
// account) and this module creates everything ZateDB-specific inside them —
// its own managed identity, its own replication topic, its own Cosmos
// database and containers, and every role assignment those need. Nothing has
// to be created by hand first.
//
// Minimal call — containerImage defaults to the published GHCR image, so it
// can be omitted entirely unless you're pinning a different tag or pulling
// from a private registry:
//
//   module zatedb 'modules/zatedb.bicep' = {
//     name: 'zatedb'
//     params: {
//       namePrefix: 'contoso'
//       managedEnvironmentId: env.id
//       serviceBusNamespaceName: sb.name
//       cosmosAccountName: cosmos.name
//       authPassword: redisPassword
//     }
//   }
//
// See infra/README.md for the "I already have Cosmos" variants, and
// docs/high-availability.md for the architecture this maps to.

// ---------------------------------------------------------------- naming --

@description('Name prefix for resources this module creates')
param namePrefix string

@description('Location for resources this module creates')
param location string = resourceGroup().location

// ------------------------------------------------------------- container --

@description('Resource ID of the existing Container Apps Environment. The consuming app must run in this same environment — internal ingress is environment-scoped, so nothing outside it can reach ZateDB at all.')
param managedEnvironmentId string

@description('Container image, e.g. <registry>.azurecr.io/zatedb:<tag>. Pin a digest or an immutable tag; Container Apps resolves a tag to a digest once, at revision-creation time, so a revision pointing at :latest keeps serving whatever it first pulled. Defaults to the published GHCR image at the version this module ships with; override to pin a different tag/digest or to use a private registry.')
param containerImage string = 'ghcr.io/davidyack/zatedb:0.1.2'

@description('Name of the container registry to pull from, when it is a private Azure Container Registry. Leave empty for a public image. When set, this module grants its identity AcrPull.')
param containerRegistryName string = ''

@description('Resource group owning the container registry. Defaults to this deployment\'s resource group.')
param containerRegistryResourceGroupName string = resourceGroup().name

@description('Subscription owning the container registry. Defaults to this deployment\'s subscription.')
param containerRegistrySubscriptionId string = subscription().subscriptionId

// --------------------------------------------------------------- secrets --

@description('RESP AUTH password. The consuming app needs this value too, to build its own REDIS_URL, so it is passed in rather than generated here — Bicep outputs are not secure and could not hand it back safely.')
@secure()
param authPassword string

@description('Admin API bearer token. Empty means the admin API relies on network isolation alone (it is never exposed through ingress).')
@secure()
param adminToken string = ''

@description('Optional Key Vault secret URI for the RESP AUTH password, for shops that require secrets to live in Key Vault. When set, it supersedes authPassword and this module grants its identity Key Vault access at your Key Vault, not here.')
param authPasswordSecretUri string = ''

@description('Optional Key Vault secret URI for the admin token. See authPasswordSecretUri.')
param adminTokenSecretUri string = ''

// ----------------------------------------------------------- service bus --

@description('Name of the existing Service Bus namespace used for cross-node replication')
param serviceBusNamespaceName string

@description('Resource group owning the Service Bus namespace. Defaults to this deployment\'s resource group.')
param serviceBusResourceGroupName string = resourceGroup().name

@description('Subscription owning the Service Bus namespace. Defaults to this deployment\'s subscription.')
param serviceBusSubscriptionId string = subscription().subscriptionId

@description('Replication topic name')
param serviceBusTopicName string = 'zatedb-replication'

@description('Create the replication topic. False when you already manage it.')
param createServiceBusTopic bool = true

// ------------------------------------------------------------- cosmos db --

@description('Name of the existing Cosmos DB (NoSQL API) account used as the durable store')
param cosmosAccountName string

@description('Resource group owning the Cosmos account. Defaults to this deployment\'s resource group.')
param cosmosResourceGroupName string = resourceGroup().name

@description('Subscription owning the Cosmos account. Defaults to this deployment\'s subscription.')
param cosmosSubscriptionId string = subscription().subscriptionId

@description('Database ZateDB uses. Defaults to a dedicated database inside your existing account, so ZateDB never shares a throughput pool with your application containers.')
param cosmosDatabaseName string = 'zatedb'

@description('Container for key state, partitioned on /key')
param cosmosKeysContainerName string = 'keys'

@description('Container for node heartbeat/topology snapshots, partitioned on /nodeId')
param cosmosNodesContainerName string = 'nodes'

@description('Create the Cosmos database. False to reuse a database you already manage.')
param createCosmosDatabase bool = true

@description('Create the Cosmos containers. False when you have already created them — they must then match the partition keys and TTL documented in infra/README.md, and this module only grants access.')
param createCosmosContainers bool = true

@description('Autoscale max RU/s for the Cosmos database. 0 leaves throughput unset, which is required on serverless accounts.')
param cosmosAutoscaleMaxThroughput int = 0

// --------------------------------------------------------------- telemetry --

@description('Application Insights connection string. Empty disables the Azure Monitor exporter.')
param appInsightsConnectionString string = ''

// ----------------------------------------------------------------- tuning --

@description('Optional tuning. Anything left unset keeps the application default documented in docs/deployment.md, rather than being pinned here — so defaults live in one place.')
param tuning zateDbTuning = {}

@export()
@description('Optional tuning knobs. Scale settings shape the Container App; the rest map to the environment variables in docs/deployment.md.')
type zateDbTuning = {
  @minValue(2)
  @description('HA requires at least 2 so a single node restarting never drops the service to zero.')
  minReplicas: int?

  maxReplicas: int?

  @description('Concurrent TCP connections per replica before scaling out. Connection count, not CPU, is the load driver for a RESP service.')
  concurrentConnections: int?

  cpu: string?
  memory: string?

  @description('DURABILITY_MIN_TTL_MS. 60000 drops the dominant rate-limit/sliding-window write RU; peers still converge over Service Bus.')
  durabilityMinTtlMs: int?

  maxKeys: int?
  maxMemoryBytes: int?
  maxClients: int?
  idleTimeoutMs: int?
  heartbeatIntervalMs: int?
  nodeStaleMs: int?
  antiEntropyIntervalMs: int?
  clusterStartupTimeoutMs: int?
  maxFailedAuthAttempts: int?
  slowCommandLogMs: int?

  @description('Escape hatch for any environment variable in docs/deployment.md not surfaced above.')
  extraEnv: environmentVariable[]?
}

@export()
type environmentVariable = {
  name: string
  value: string
}

// ------------------------------------------------------------------ vars --

var respPort = 6379
var healthPort = 8081
var adminPort = 8082

var appName = '${namePrefix}-zatedb'
var usePrivateRegistry = !empty(containerRegistryName)
var useKeyVaultSecrets = !empty(authPasswordSecretUri)
var hasAdminToken = !empty(adminToken) || !empty(adminTokenSecretUri)

// Only keys the caller actually set end up here, so an unset knob inherits
// the application default rather than having it restated in two places.
var tuningEnvMap = union(
  tuning.?durabilityMinTtlMs == null ? {} : { DURABILITY_MIN_TTL_MS: string(tuning.?durabilityMinTtlMs ?? 0) },
  tuning.?maxKeys == null ? {} : { MAX_KEYS: string(tuning.?maxKeys ?? 0) },
  tuning.?maxMemoryBytes == null ? {} : { MAX_MEMORY_BYTES: string(tuning.?maxMemoryBytes ?? 0) },
  tuning.?maxClients == null ? {} : { MAX_CLIENTS: string(tuning.?maxClients ?? 0) },
  tuning.?idleTimeoutMs == null ? {} : { IDLE_TIMEOUT_MS: string(tuning.?idleTimeoutMs ?? 0) },
  tuning.?heartbeatIntervalMs == null ? {} : { HEARTBEAT_INTERVAL_MS: string(tuning.?heartbeatIntervalMs ?? 0) },
  tuning.?nodeStaleMs == null ? {} : { NODE_STALE_MS: string(tuning.?nodeStaleMs ?? 0) },
  tuning.?antiEntropyIntervalMs == null ? {} : { ANTI_ENTROPY_INTERVAL_MS: string(tuning.?antiEntropyIntervalMs ?? 0) },
  tuning.?clusterStartupTimeoutMs == null
    ? {}
    : { CLUSTER_STARTUP_TIMEOUT_MS: string(tuning.?clusterStartupTimeoutMs ?? 0) },
  tuning.?maxFailedAuthAttempts == null ? {} : { MAX_FAILED_AUTH_ATTEMPTS: string(tuning.?maxFailedAuthAttempts ?? 0) },
  tuning.?slowCommandLogMs == null ? {} : { SLOW_COMMAND_LOG_MS: string(tuning.?slowCommandLogMs ?? 0) }
)

var baseEnv = [
  { name: 'RESP_PORT', value: string(respPort) }
  { name: 'HEALTH_PORT', value: string(healthPort) }
  { name: 'ADMIN_PORT', value: string(adminPort) }
  { name: 'REDIS_AUTH_PASSWORD', secretRef: 'redis-auth' }
  // At two or more replicas a partial HA config must never silently fall
  // back to standalone: that would put several independent, non-replicating
  // nodes behind one load balancer (split-brain, divergent per-connection
  // keyspaces). This makes it a hard startup failure instead. Safe to assert
  // unconditionally here because this module always provisions both halves.
  { name: 'REQUIRE_HA', value: 'true' }
  // Pins which identity DefaultAzureCredential picks for Service Bus and
  // Cosmos AAD auth rather than letting it guess among any others attached.
  { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
  { name: 'SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE', value: serviceBus.outputs.fullyQualifiedNamespace }
  { name: 'SERVICE_BUS_TOPIC_NAME', value: serviceBusTopicName }
  { name: 'COSMOS_ENDPOINT', value: cosmos.outputs.endpoint }
  { name: 'COSMOS_DATABASE', value: cosmosDatabaseName }
  { name: 'COSMOS_KEYS_CONTAINER', value: cosmosKeysContainerName }
  { name: 'COSMOS_NODES_CONTAINER', value: cosmosNodesContainerName }
  // NODE_ID is deliberately unset: cluster/nodeId.ts falls back to
  // CONTAINER_APP_REPLICA_NAME, which Container Apps sets uniquely per
  // replica for free.
]

var containerEnv = concat(
  baseEnv,
  hasAdminToken ? [{ name: 'ADMIN_TOKEN', secretRef: 'admin-token' }] : [],
  empty(appInsightsConnectionString)
    ? []
    : [{ name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }],
  map(items(tuningEnvMap), item => { name: item.key, value: item.value }),
  tuning.?extraEnv ?? []
)

var authSecret = useKeyVaultSecrets
  ? { name: 'redis-auth', keyVaultUrl: authPasswordSecretUri, identity: identity.id }
  : { name: 'redis-auth', value: authPassword }

var adminSecret = !empty(adminTokenSecretUri)
  ? [{ name: 'admin-token', keyVaultUrl: adminTokenSecretUri, identity: identity.id }]
  : (empty(adminToken) ? [] : [{ name: 'admin-token', value: adminToken }])

var containerSecrets = concat([authSecret], adminSecret)

// ------------------------------------------------------------- resources --

// ZateDB runs as its own identity rather than borrowing the consuming app's,
// so the data-plane grants below stay scoped to exactly what ZateDB needs.
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${appName}-id'
  location: location
}

module cosmos 'cosmos-resources.bicep' = {
  name: '${deployment().name}-cosmos'
  scope: resourceGroup(cosmosSubscriptionId, cosmosResourceGroupName)
  params: {
    accountName: cosmosAccountName
    databaseName: cosmosDatabaseName
    keysContainerName: cosmosKeysContainerName
    nodesContainerName: cosmosNodesContainerName
    principalId: identity.properties.principalId
    createDatabase: createCosmosDatabase
    createContainers: createCosmosContainers
    autoscaleMaxThroughput: cosmosAutoscaleMaxThroughput
  }
}

module serviceBus 'servicebus-resources.bicep' = {
  name: '${deployment().name}-sb'
  scope: resourceGroup(serviceBusSubscriptionId, serviceBusResourceGroupName)
  params: {
    namespaceName: serviceBusNamespaceName
    topicName: serviceBusTopicName
    principalId: identity.properties.principalId
    createTopic: createServiceBusTopic
  }
}

module acr 'acr-pull.bicep' = if (usePrivateRegistry) {
  name: '${deployment().name}-acr'
  scope: resourceGroup(containerRegistrySubscriptionId, containerRegistryResourceGroupName)
  params: {
    registryName: containerRegistryName
    principalId: identity.properties.principalId
  }
}

resource zateDb 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironmentId
    configuration: {
      ingress: {
        // No public endpoint, ever. Reachable only from other apps in the
        // same Container Apps Environment — strictly better isolation than a
        // managed Redis behind a private endpoint, which still has a public
        // control surface. Internal TCP ingress also needs no custom VNet.
        external: false
        targetPort: respPort
        exposedPort: respPort
        transport: 'tcp'
      }
      secrets: containerSecrets
      registries: usePrivateRegistry
        ? [
            {
              server: '${containerRegistryName}.azurecr.io'
              identity: identity.id
            }
          ]
        : []
    }
    template: {
      containers: [
        {
          name: 'zatedb'
          image: containerImage
          resources: {
            cpu: json(tuning.?cpu ?? '0.25')
            memory: tuning.?memory ?? '0.5Gi'
          }
          env: containerEnv
          probes: [
            {
              // Never gates on hydration — a node mid-hydration is alive,
              // just not ready for traffic yet.
              type: 'Liveness'
              httpGet: { port: healthPort, path: '/healthz' }
              periodSeconds: 15
            }
            {
              // Fails (503) until this node has finished loading its
              // in-memory copy from Cosmos, so Container Apps never routes a
              // client to a node serving a cold cache right after scale-out
              // or a restart. See src/http/healthServer.ts.
              type: 'Readiness'
              httpGet: { port: healthPort, path: '/readyz' }
              periodSeconds: 5
            }
          ]
        }
      ]
      scale: {
        minReplicas: tuning.?minReplicas ?? 2
        maxReplicas: tuning.?maxReplicas ?? 5
        rules: [
          {
            name: 'tcp-connections'
            tcp: {
              metadata: {
                concurrentConnections: string(tuning.?concurrentConnections ?? 200)
              }
            }
          }
        ]
      }
    }
  }
  dependsOn: [acr]
}

// -------------------------------------------------------------- outputs ---

@description('Hostname to connect to from another app in the same environment. Container Apps resolves an app\'s name internally, so this is the host for your REDIS_URL.')
output host string = zateDb.name

@description('RESP port')
output port int = respPort

@description('host:port, ready to interpolate into redis://:<password>@<hostAndPort>')
output hostAndPort string = '${zateDb.name}:${respPort}'

@description('Internal FQDN, for callers that prefer it over the short name')
output fqdn string = zateDb.properties.configuration.ingress.fqdn

@description('Principal ID of ZateDB\'s identity, for granting it anything else it needs')
output principalId string = identity.properties.principalId

@description('Resource ID of ZateDB\'s identity')
output identityId string = identity.id

@description('Container App name')
output name string = zateDb.name
