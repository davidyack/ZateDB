// Deployment sketch for BackendCache as a single-replica Azure Container App,
// internal-only ingress, inside a Container Apps Environment the consuming
// app's infrastructure already provisions. Not a complete, standalone
// template — it assumes `containerEnv`, `acr`, `appIdentity`, and
// `appInsights` are defined/passed in from the surrounding infra.

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

@description('Application Insights connection string')
param appInsightsConnectionString string

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
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: { port: 8081, path: '/healthz' }
              periodSeconds: 15
            }
            {
              type: 'Readiness'
              httpGet: { port: 8081, path: '/healthz' }
              periodSeconds: 5
            }
          ]
        }
      ]
      // Deliberately not autoscaled: running >1 replica of BackendCache
      // would reintroduce the cross-replica coordination problem it exists
      // to solve. See README "Why single-replica".
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

output backendCacheFqdn string = backendCacheApp.properties.configuration.ingress.fqdn
