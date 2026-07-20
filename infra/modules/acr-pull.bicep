// AcrPull for ZateDB's identity, deployed into the resource group that owns
// the registry. Only used when the consumer pulls the ZateDB image from a
// private Azure Container Registry.

@description('Name of the existing container registry')
param registryName string

@description('Principal ID of the identity ZateDB runs as')
param principalId string

var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource pull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, principalId, acrPullRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

output loginServer string = registry.properties.loginServer
