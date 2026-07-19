import type { Store } from '../store/store.js';
import type { PubSubRegistry } from '../pubsub/registry.js';
import type { RespValue } from '../resp/types.js';
import type { ServerConfig } from '../config.js';

export type ConnectionMode = 'handshake' | 'command' | 'subscriber';

/** What command handlers need from a live connection, without depending on the transport layer. */
export interface ConnectionContext {
  readonly id: string;
  authenticated: boolean;
  mode: ConnectionMode;
  clientName: string | null;
  remoteAddress: string;

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
}

export interface CommandResult {
  frames: RespValue[];
  closeAfter?: boolean;
}

export function result(...frames: RespValue[]): CommandResult {
  return { frames };
}

export type CommandHandler = (ctx: CommandContext, args: string[]) => CommandResult;
