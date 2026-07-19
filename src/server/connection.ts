import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { RespRequestParser } from '../resp/parser.js';
import { serialize } from '../resp/serializer.js';
import { array, bulk } from '../resp/types.js';
import { RespProtocolError } from '../resp/types.js';
import { error as respError } from '../resp/types.js';
import type { Store } from '../store/store.js';
import type { PubSubRegistry } from '../pubsub/registry.js';
import type { ServerConfig } from '../config.js';
import type { ClusterCoordinator } from '../cluster/clusterCoordinator.js';
import type { ConnectionContext, ConnectionMode } from '../commands/context.js';
import { dispatch } from '../commands/dispatcher.js';
import {
  traceCommand,
  recordConnectionClosed,
  recordConnectionOpened,
  recordSubscriptionChange,
  recordConnectionLifecycleEvent,
} from '../telemetry/commandTelemetry.js';
import { logger } from '../logger.js';

export interface ConnectionDeps {
  store: Store;
  pubsub: PubSubRegistry;
  config: ServerConfig;
  cluster: ClusterCoordinator;
}

/**
 * Owns one client TCP socket end to end: RESP framing, command dispatch,
 * pub/sub push delivery, and state (auth / handshake / subscriber mode).
 * On close, always cleans up pub/sub registrations — a dangling subscriber
 * reference is a leak and a PUBLISH-to-dead-socket bug waiting to happen.
 */
export class Connection implements ConnectionContext {
  readonly id: string = randomUUID();
  authenticated = false;
  mode: ConnectionMode = 'handshake';
  clientName: string | null = null;
  readonly remoteAddress: string;

  private parser = new RespRequestParser();
  private closed = false;

  constructor(private readonly socket: Socket, private readonly deps: ConnectionDeps) {
    this.remoteAddress = `${socket.remoteAddress ?? 'unknown'}:${socket.remotePort ?? 0}`;
    this.mode = 'command';
    recordConnectionOpened();
    recordConnectionLifecycleEvent('connection.opened', { connectionId: this.id, remoteAddress: this.remoteAddress });

    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (err) => this.onError(err));
    socket.on('close', () => this.onClose());
  }

  private onData(chunk: Buffer): void {
    let commands: string[][];
    try {
      commands = this.parser.feed(chunk);
    } catch (err) {
      if (err instanceof RespProtocolError) {
        this.write(respError(`ERR Protocol error: ${err.message}`));
        this.socket.end();
        return;
      }
      throw err;
    }

    for (const rawArgs of commands) {
      if (rawArgs.length === 0) continue;
      this.handleCommand(rawArgs);
      if (this.closed) break;
    }
  }

  private handleCommand(rawArgs: string[]): void {
    const command = rawArgs[0].toUpperCase();
    const keyArg = rawArgs.length > 1 ? rawArgs[1] : undefined;

    const outcome = traceCommand(command, this.id, keyArg, () =>
      dispatch(
        { store: this.deps.store, pubsub: this.deps.pubsub, conn: this, config: this.deps.config, cluster: this.deps.cluster },
        rawArgs,
      ),
    );

    for (const frame of outcome.frames) this.write(frame);

    if (outcome.closeAfter) {
      this.socket.end();
    }
  }

  private write(frame: Parameters<typeof serialize>[0]): void {
    if (this.socket.writable) this.socket.write(serialize(frame));
  }

  private onError(err: Error): void {
    logger.warn('connection.error', { connectionId: this.id, remoteAddress: this.remoteAddress, error: err.message });
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    const channels = this.deps.pubsub.subscribedChannels(this);
    const patterns = this.deps.pubsub.subscribedPatterns(this);
    this.deps.pubsub.unsubscribeAll(this);
    if (channels.length) recordSubscriptionChange('channel', -channels.length);
    if (patterns.length) recordSubscriptionChange('pattern', -patterns.length);
    recordConnectionClosed();
    recordConnectionLifecycleEvent('connection.closed', {
      connectionId: this.id,
      remoteAddress: this.remoteAddress,
      channelSubscriptions: channels.length,
      patternSubscriptions: patterns.length,
    });
    logger.debug('connection.closed', { connectionId: this.id, remoteAddress: this.remoteAddress });
  }

  /** Forcibly ends the socket (used by graceful shutdown). */
  end(): void {
    this.socket.end();
  }

  destroy(): void {
    this.socket.destroy();
  }

  // ---- ConnectionContext / pubsub.Subscriber -----------------------------

  sendMessage(channel: string, message: string): void {
    this.write(array([bulk('message'), bulk(channel), bulk(message)]));
  }

  sendPMessage(pattern: string, channel: string, message: string): void {
    this.write(array([bulk('pmessage'), bulk(pattern), bulk(channel), bulk(message)]));
  }

  totalSubscriptions(): number {
    return this.deps.pubsub.channelSubscriptionCount(this) + this.deps.pubsub.patternSubscriptionCount(this);
  }
}
