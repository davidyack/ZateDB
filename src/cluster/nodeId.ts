import { randomUUID } from 'node:crypto';

/**
 * Stable-enough identity for this process to use as a Service Bus
 * subscription name and Cosmos DB node-heartbeat document id. Prefers
 * Container Apps' own per-replica identifier (set automatically on every
 * revision) so restarts of the *same* replica reuse the same id; falls
 * back to a random id for local/dev runs and any other host.
 */
export function resolveNodeId(env: NodeJS.ProcessEnv = process.env): string {
  return env.NODE_ID || env.CONTAINER_APP_REPLICA_NAME || `node-${randomUUID().slice(0, 8)}`;
}
