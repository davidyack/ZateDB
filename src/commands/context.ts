import type { Store } from '../store/store.js';
import type { PubSubRegistry } from '../pubsub/registry.js';
import type { Protover, RespValue } from '../resp/types.js';
import type { ServerConfig } from '../config.js';
import type { ClusterCoordinator } from '../cluster/clusterCoordinator.js';

export type ConnectionMode = 'handshake' | 'command' | 'subscriber';

/** What command handlers need from a live connection, without depending on the transport layer. */
export interface ConnectionContext {
  readonly id: string;
  authenticated: boolean;
  mode: ConnectionMode;
  clientName: string | null;
  remoteAddress: string;
  /** Consecutive failed AUTH attempts on this connection; reset to 0 on success. Backs failed-auth throttling. */
  failedAuthCount: number;
  /** RESP protocol version negotiated via HELLO. Defaults to 2 until a client asks for 3. */
  protover: Protover;

  sendMessage(channel: string, message: string): void;
  sendPMessage(pattern: string, channel: string, message: string): void;
  /** Total active channel + pattern subscriptions, used in SUBSCRIBE/UNSUBSCRIBE reply counts. */
  totalSubscriptions(): number;
}

export interface CommandContext {
  store: Store;
  pubsub: PubSubRegistry;
  conn: ConnectionContext;
  config: ServerConfig;
  cluster: ClusterCoordinator;
}

export interface CommandResult {
  frames: RespValue[];
  closeAfter?: boolean;
}

export function result(...frames: RespValue[]): CommandResult {
  return { frames };
}

export type CommandHandler = (ctx: CommandContext, args: string[]) => CommandResult;
