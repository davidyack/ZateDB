// ZateDB's Service Bus resources, deployed into the resource group that owns
// the namespace — same cross-scope reason as cosmos-resources.bicep.
//
// The namespace is always assumed to exist. ZateDB adds one topic and takes
// data access on it; each node then creates and deletes its *own*
// subscription at startup/shutdown, which is why the role has to cover
// manage as well as send/receive. See docs/high-availability.md.

@description('Name of the existing Service Bus namespace')
param namespaceName string

@description('Topic every ZateDB node publishes replication events to')
param topicName string

@description('Principal ID of the identity ZateDB runs as')
param principalId string

@description('Create the topic. False when the consumer already manages it.')
param createTopic bool = true

// Azure Service Bus Data Owner — full access to the entity, including the
// subscription management each node performs on itself.
var dataOwnerRoleId = '090c5cfd-751d-490a-894a-3ce6f1109419'

resource namespace 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' existing = {
  name: namespaceName
}

resource newTopic 'Microsoft.ServiceBus/namespaces/topics@2022-10-01-preview' = if (createTopic) {
  parent: namespace
  name: topicName
  properties: {
    // Replication events are small and consumed within seconds; a long TTL
    // would only let a partitioned-off node's backlog pile up.
    defaultMessageTimeToLive: 'PT5M'
    enablePartitioning: false
  }
}

// Referenced rather than parented so the role assignment below can target
// the topic whether this module created it or it already existed. The
// ordering is carried by the assignment's own dependsOn.
resource topic 'Microsoft.ServiceBus/namespaces/topics@2022-10-01-preview' existing = {
  parent: namespace
  name: topicName
}

// Scoped to the topic rather than the namespace — the narrowest scope that
// still lets a node manage its own subscription, so ZateDB gets no access to
// other queues or topics the consumer keeps in the same namespace.
resource dataAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: topic
  name: guid(topic.id, principalId, dataOwnerRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', dataOwnerRoleId)
    principalId: principalId
    // Set explicitly so the assignment doesn't fail while a just-created
    // managed identity is still replicating through Entra ID.
    principalType: 'ServicePrincipal'
  }
  dependsOn: [newTopic]
}

output fullyQualifiedNamespace string = replace(
  replace(namespace.properties.serviceBusEndpoint, 'https://', ''),
  ':443/',
  ''
)
output topicName string = topicName
