// ZateDB's Cosmos DB resources, deployed into the resource group that owns
// the Cosmos account — which is usually *not* the resource group ZateDB
// itself lives in. That is the entire reason this is a separate module:
// Bicep's `parent:` can't cross a scope boundary, so the caller invokes this
// with `scope: resourceGroup(<sub>, <rg>)`.
//
// The account is always assumed to exist. Everything below it is ZateDB's
// own — see infra/README.md for the four "I already have Cosmos" cases and
// which flags each one needs.

@description('Name of the existing Cosmos DB (NoSQL API) account')
param accountName string

@description('Database ZateDB uses. Defaults to a dedicated database rather than sharing the consumer\'s, so ZateDB\'s containers never compete for a shared-throughput RU pool.')
param databaseName string

@description('Container for key state, partitioned on /key')
param keysContainerName string

@description('Container for node heartbeat/topology snapshots, partitioned on /nodeId')
param nodesContainerName string

@description('Principal ID of the identity ZateDB runs as, granted data-plane access below')
param principalId string

@description('Create the database. False when pointing ZateDB at a database the consumer already manages.')
param createDatabase bool = true

@description('Create the two containers. False when the consumer has already created them — in which case they must match the partition keys and TTL settings documented in infra/README.md, and this module only grants access.')
param createContainers bool = true

@description('Autoscale max RU/s for the database. 0 leaves throughput unset, which is required for serverless accounts and gives per-container defaults on provisioned ones.')
param autoscaleMaxThroughput int = 0

// Cosmos DB Built-in Data Contributor. The GUID is fixed across every
// account; only the account prefix varies.
var dataContributorRoleId = '00000000-0000-0000-0000-000000000002'

resource account 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' existing = {
  name: accountName
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' = if (createDatabase) {
  parent: account
  name: databaseName
  properties: {
    resource: {
      id: databaseName
    }
    options: autoscaleMaxThroughput > 0
      ? {
          autoscaleSettings: {
            maxThroughput: autoscaleMaxThroughput
          }
        }
      : {}
  }
}

// The containers use the flattened `<account>/<database>/<container>` name
// form rather than `parent:` because the parent database is conditional —
// it may have been created above or may already exist. `dependsOn` on a
// resource whose condition is false is simply ignored.
resource keysContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = if (createContainers) {
  #disable-next-line use-parent-property
  name: '${accountName}/${databaseName}/${keysContainerName}'
  properties: {
    resource: {
      id: keysContainerName
      partitionKey: {
        paths: ['/key']
        kind: 'Hash'
      }
      // "On, but no default" — every document sets its own `ttl`, so Cosmos
      // evicts expired keys and the container doesn't grow monotonically
      // with the keyspace. Without this the per-document ttl is ignored.
      defaultTtl: -1
      // The default policy indexes every path in every document — every
      // field of every presence hash, every member of every sliding-window
      // zset. Write RU scales with indexed path count, so the default makes
      // each patch pay to index data no query reads. These three paths are
      // the only ones cosmosDurableStore.ts queries on.
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [
          { path: '/key/?' }
          { path: '/updatedAtMs/?' }
          { path: '/entry/expiresAtMs/?' }
        ]
        excludedPaths: [
          { path: '/*' }
        ]
      }
    }
  }
  dependsOn: [database]
}

resource nodesContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = if (createContainers) {
  #disable-next-line use-parent-property
  name: '${accountName}/${databaseName}/${nodesContainerName}'
  properties: {
    resource: {
      id: nodesContainerName
      partitionKey: {
        paths: ['/nodeId']
        kind: 'Hash'
      }
      // A crashed node's heartbeat doc self-expires via its per-document ttl
      // (~2x NODE_STALE_MS) instead of lingering in cluster views forever.
      defaultTtl: -1
    }
  }
  dependsOn: [database]
}

// Scoped to ZateDB's own database, not the account root. In a shared account
// this is what makes reuse safe: the identity can read and write exactly the
// two containers below and nothing else the consumer keeps in that account.
resource dataAccess 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: account
  name: guid(account.id, principalId, dataContributorRoleId, databaseName)
  properties: {
    roleDefinitionId: '${account.id}/sqlRoleDefinitions/${dataContributorRoleId}'
    principalId: principalId
    scope: '${account.id}/dbs/${databaseName}'
  }
  dependsOn: [database]
}

output endpoint string = account.properties.documentEndpoint
output databaseName string = databaseName
