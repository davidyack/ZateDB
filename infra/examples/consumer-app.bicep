// A worked example of pulling ZateDB into an application's own Bicep: an API
// container app that talks to ZateDB over the standard `redis` client, with
// no code changes beyond REDIS_URL.
//
// Everything ZateDB needs is created by the module. This file only supplies
// names of infrastructure the application already has.
//
//   az deployment group create \
//     -g rg-contoso \
//     -f infra/examples/consumer-app.bicep \
//     -p namePrefix=contoso \
//        serviceBusNamespaceName=contoso-sb \
//        cosmosAccountName=contoso-cosmos \
//        apiImage=myregistry.azurecr.io/api:abc123

param namePrefix string
param location string = resourceGroup().location

param containerAppsEnvironmentName string

@description('Defaults to the published ghcr.io/davidyack/zatedb image; override to pin a different tag/digest or pull from a private registry (with containerRegistryName).')
param containerImage string = 'ghcr.io/davidyack/zatedb:0.1.2'
param containerRegistryName string = ''
param serviceBusNamespaceName string
param cosmosAccountName string
param apiImage string

@description('Shared between ZateDB and the API — ZateDB enforces it on AUTH, the API sends it in REDIS_URL. Generate once and keep it in your own Key Vault or pipeline secret store.')
@secure()
param redisPassword string

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: containerAppsEnvironmentName
}

module zatedb '../modules/zatedb.bicep' = {
  name: 'zatedb'
  params: {
    namePrefix: namePrefix
    location: location
    managedEnvironmentId: containerAppsEnvironment.id
    containerImage: containerImage
    containerRegistryName: containerRegistryName
    serviceBusNamespaceName: serviceBusNamespaceName
    cosmosAccountName: cosmosAccountName
    authPassword: redisPassword
    tuning: {
      // Skip persisting rate-limit / sliding-window churn that resets in
      // seconds; peers still converge over Service Bus. Usually the single
      // largest reduction in durable writes.
      durabilityMinTtlMs: 60000
      maxReplicas: 8
    }
  }
}

resource api 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-api'
  location: location
  properties: {
    managedEnvironmentId: containerAppsEnvironment.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
      }
      secrets: [
        {
          name: 'redis-url'
          // ZateDB is reachable at its app name from inside the environment.
          // This is an ordinary Redis URL — the API's existing `redis`
          // client, rate-limit store, and Socket.IO adapter need no changes.
          value: 'redis://:${redisPassword}@${zatedb.outputs.hostAndPort}'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'api'
          image: apiImage
          env: [
            { name: 'REDIS_URL', secretRef: 'redis-url' }
          ]
        }
      ]
      scale: {
        minReplicas: 2
        maxReplicas: 10
      }
    }
  }
}

output apiFqdn string = api.properties.configuration.ingress.fqdn
output zatedbHost string = zatedb.outputs.host
