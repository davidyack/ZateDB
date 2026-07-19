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
interface CosmosPatchOperation {
  op: 'set' | 'remove';
  path: string;
  value?: unknown;
}
interface CosmosItemLike {
  delete(): Promise<unknown>;
  patch(operations: CosmosPatchOperation[]): Promise<unknown>;
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

/** Escapes a hash field / sorted-set member name for use as a JSON Pointer path segment (RFC 6901: '~' -> '~0', '/' -> '~1'). */
function escapeJsonPointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 404;
}

/** Cosmos DB's documented limit on the number of operations in a single Patch request. */
const PATCH_BATCH_SIZE = 10;

interface FieldOp {
  name: string;
  op: 'set' | 'remove';
  value?: unknown;
}

/**
 * Durable backing store for cluster mode: Cosmos DB as the source of truth
 * a node hydrates from at startup. Uses plain upserts/deletes and the
 * Patch API (no stored procedures, no Lua) — atomicity per key/field
 * comes from Cosmos's own document/property-level write semantics,
 * matching the same eventual-sync model the Service Bus replication
 * transport uses. See docs/high-availability.md for the consistency
 * model this implies.
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

  async putHashFields(key: string, fields: Array<[string, string]>): Promise<void> {
    await this.patchSubDocument(
      key,
      'fields',
      fields.map(([name, value]): FieldOp => ({ name, op: 'set', value })),
      () => ({
        id: toDocId(key),
        key,
        entry: { type: 'hash', fields: Object.fromEntries(fields), expiresAtMs: null },
        updatedAtMs: Date.now(),
      }),
    );
  }

  async deleteHashFields(key: string, fields: string[]): Promise<void> {
    await this.patchSubDocument(
      key,
      'fields',
      fields.map((name): FieldOp => ({ name, op: 'remove' })),
      null, // nothing to delete from a document that doesn't exist — no fallback creation
    );
  }

  async putZsetMembers(key: string, members: Array<[string, number]>): Promise<void> {
    await this.patchSubDocument(
      key,
      'members',
      members.map(([name, value]): FieldOp => ({ name, op: 'set', value })),
      () => ({
        id: toDocId(key),
        key,
        entry: { type: 'sortedset', members: Object.fromEntries(members), expiresAtMs: null },
        updatedAtMs: Date.now(),
      }),
    );
  }

  async deleteZsetMembers(key: string, members: string[]): Promise<void> {
    await this.patchSubDocument(
      key,
      'members',
      members.map((name): FieldOp => ({ name, op: 'remove' })),
      null,
    );
  }

  /**
   * Applies field/member-level operations via Cosmos's Patch API — a
   * targeted `set`/`remove` on `/entry/<subField>/<name>`, not a
   * read-modify-write of the whole document, so two nodes patching
   * *different* fields of the same key never race on the whole entry.
   * Batched at PATCH_BATCH_SIZE ops per request (Cosmos's own limit). If
   * the very first batch 404s (the document doesn't exist yet),
   * buildFallbackDoc creates it in one upsert covering every operation in
   * this call — there's nothing to reconcile from later batches since the
   * fallback already captures all of them. A 404 on any *later* batch
   * would mean the document vanished mid-patch (e.g. a concurrent whole-key
   * delete) — an unexpected but non-corrupting race, surfaced by rethrowing
   * so the caller's existing best-effort logging picks it up rather than
   * silently losing the rest of the write.
   */
  private async patchSubDocument(
    key: string,
    subField: 'fields' | 'members',
    ops: FieldOp[],
    buildFallbackDoc: (() => Record<string, unknown>) | null,
  ): Promise<void> {
    if (ops.length === 0) return;
    const id = toDocId(key);
    for (let i = 0; i < ops.length; i += PATCH_BATCH_SIZE) {
      const batch = ops.slice(i, i + PATCH_BATCH_SIZE);
      const patchOps: CosmosPatchOperation[] = batch.map((fieldOp) => ({
        op: fieldOp.op,
        path: `/entry/${subField}/${escapeJsonPointerSegment(fieldOp.name)}`,
        value: fieldOp.value,
      }));
      try {
        await this.keysContainer.item(id, key).patch(patchOps);
      } catch (err) {
        if (isNotFound(err) && i === 0) {
          if (buildFallbackDoc) await this.keysContainer.items.upsert(buildFallbackDoc());
          return; // the fallback doc (or the no-op delete case) already covers every op in `ops`
        }
        throw err;
      }
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
