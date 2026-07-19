import type { DurableStore } from './durableStore.js';
import type { EntrySnapshot, NodeSnapshot } from './types.js';
import { errorMessage, logger } from '../logger.js';

export interface CosmosConfig {
  /** Full account connection string (key-based auth). Takes precedence over endpoint+AAD. */
  connectionString: string | null;
  /** Account endpoint for AAD (managed identity) auth, used when connectionString is unset. */
  endpoint: string | null;
  database: string;
  keysContainer: string;
  nodesContainer: string;
}

/**
 * Minimal structural subset of the @azure/cosmos SDK surface this module
 * actually uses. Declared locally (rather than importing the SDK's own
 * types) because @azure/cosmos is an optionalDependency — see
 * optionalAzureModules.d.ts — and its real class instances satisfy this
 * shape structurally, so no cast is needed when it *is* installed.
 */
interface CosmosFeedResponse<T> {
  resources: T[];
}
interface CosmosQueryIterator<T> {
  hasMoreResults(): boolean;
  fetchNext(): Promise<CosmosFeedResponse<T>>;
  fetchAll(): Promise<CosmosFeedResponse<T>>;
}
interface CosmosItemLike {
  delete(): Promise<unknown>;
}
interface CosmosContainerLike {
  items: {
    upsert(body: Record<string, unknown>): Promise<unknown>;
    query<T>(spec: { query: string }, options?: { maxItemCount?: number }): CosmosQueryIterator<T>;
  };
  item(id: string, partitionKey: string): CosmosItemLike;
}
interface CosmosDatabaseLike {
  container(id: string): CosmosContainerLike;
  read(): Promise<unknown>;
}
interface CosmosClientLike {
  database(id: string): CosmosDatabaseLike;
}

/**
 * Cosmos DB document ids may not contain '/', '\\', '?', or '#', but Redis
 * key names routinely do (paths, workspace ids). The original key is kept
 * verbatim in the `key` property (and used as the partition key, which has
 * no such restriction) — this only sanitizes the `id` field.
 */
function toDocId(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64url');
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 404;
}

/**
 * Durable backing store for cluster mode: Cosmos DB as the source of truth
 * a node hydrates from at startup. Uses plain upserts/deletes (no stored
 * procedures, no Lua) — atomicity per key comes from Cosmos's own
 * last-write-wins document semantics, matching the same eventual-sync
 * model the Service Bus replication transport uses. See
 * docs/high-availability.md for the consistency model this implies.
 */
export class CosmosDurableStore implements DurableStore {
  readonly kind = 'cosmos' as const;

  private constructor(
    private readonly keysContainer: CosmosContainerLike,
    private readonly nodesContainer: CosmosContainerLike,
  ) {}

  static async create(cfg: CosmosConfig): Promise<CosmosDurableStore> {
    const { CosmosClient } = await import('@azure/cosmos');

    let client: CosmosClientLike;
    if (cfg.connectionString) {
      client = new CosmosClient(cfg.connectionString);
    } else if (cfg.endpoint) {
      const { DefaultAzureCredential } = await import('@azure/identity');
      client = new CosmosClient({ endpoint: cfg.endpoint, aadCredentials: new DefaultAzureCredential() });
    } else {
      throw new Error('Cosmos DB requires COSMOS_CONNECTION_STRING or COSMOS_ENDPOINT');
    }

    const database = client.database(cfg.database);
    const keysContainer = database.container(cfg.keysContainer);
    const nodesContainer = database.container(cfg.nodesContainer);

    // Fail fast at startup rather than on the first client write, so a
    // misconfigured database/container name surfaces immediately in logs.
    await database.read();

    return new CosmosDurableStore(keysContainer, nodesContainer);
  }

  async loadAll(): Promise<Array<{ key: string; entry: EntrySnapshot }>> {
    const iterator = this.keysContainer.items.query<{ key: string; entry: EntrySnapshot }>(
      { query: 'SELECT c.key, c.entry FROM c' },
      { maxItemCount: 500 },
    );
    const results: Array<{ key: string; entry: EntrySnapshot }> = [];
    while (iterator.hasMoreResults()) {
      const { resources } = await iterator.fetchNext();
      for (const r of resources) results.push(r);
    }
    return results;
  }

  async putKey(key: string, entry: EntrySnapshot): Promise<void> {
    await this.keysContainer.items.upsert({ id: toDocId(key), key, entry, updatedAtMs: Date.now() });
  }

  async deleteKey(key: string): Promise<void> {
    try {
      await this.keysContainer.item(toDocId(key), key).delete();
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async putNodeSnapshot(snapshot: NodeSnapshot): Promise<void> {
    await this.nodesContainer.items.upsert({ id: toDocId(snapshot.nodeId), ...snapshot });
  }

  async listNodeSnapshots(): Promise<NodeSnapshot[]> {
    const { resources } = await this.nodesContainer.items.query<NodeSnapshot>({ query: 'SELECT * FROM c' }).fetchAll();
    return resources.map(({ nodeId, lastHeartbeatMs, connectionCount, keyCounts, commandsTotal, subscriptions }) => ({
      nodeId,
      lastHeartbeatMs,
      connectionCount,
      keyCounts,
      commandsTotal,
      subscriptions,
    }));
  }

  async deleteNodeSnapshot(nodeId: string): Promise<void> {
    try {
      await this.nodesContainer.item(toDocId(nodeId), nodeId).delete();
    } catch (err) {
      if (!isNotFound(err)) logger.warn('cluster.cosmos.delete_node_snapshot_failed', { nodeId, error: errorMessage(err) });
    }
  }

  async close(): Promise<void> {
    // @azure/cosmos's CosmosClient has no explicit close/dispose — it holds
    // no long-lived socket the way ServiceBusClient does. Nothing to do.
  }
}
