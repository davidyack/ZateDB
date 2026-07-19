import type { ReplicationTransport } from './replicationTransport.js';
import type { ReplicationEvent } from './types.js';
import { errorMessage, logger } from '../logger.js';

export interface ServiceBusConfig {
  /** Full connection string (SAS-key auth). Takes precedence over fullyQualifiedNamespace. */
  connectionString: string | null;
  /** Namespace host (e.g. `my-ns.servicebus.windows.net`) for managed-identity (AAD) auth, used when connectionString is unset. */
  fullyQualifiedNamespace: string | null;
  topicName: string;
  nodeId: string;
}

/**
 * Minimal structural subset of the @azure/service-bus SDK surface this
 * module actually uses. Declared locally (rather than importing the SDK's
 * own types) because @azure/service-bus is an optionalDependency — see
 * optionalAzureModules.d.ts — and its real class instances satisfy this
 * shape structurally, so no cast is needed when it *is* installed.
 */
interface ServiceBusReceivedMessageLike {
  body: unknown;
}
interface ProcessErrorArgsLike {
  error: Error;
  errorSource: string;
}
interface ServiceBusReceiverLike {
  subscribe(handlers: {
    processMessage(message: ServiceBusReceivedMessageLike): Promise<void>;
    processError(args: ProcessErrorArgsLike): Promise<void>;
  }): void;
  close(): Promise<void>;
}
interface ServiceBusSenderLike {
  sendMessages(message: { body: unknown; contentType: string }): Promise<void>;
  close(): Promise<void>;
}
interface ServiceBusClientLike {
  createSender(topicName: string): ServiceBusSenderLike;
  createReceiver(topicName: string, subscriptionName: string, options: { receiveMode: 'receiveAndDelete' }): ServiceBusReceiverLike;
  close(): Promise<void>;
}
interface ServiceBusAdministrationClientLike {
  topicExists(topicName: string): Promise<boolean>;
  createTopic(topicName: string): Promise<unknown>;
  subscriptionExists(topicName: string, subscriptionName: string): Promise<boolean>;
  createSubscription(
    topicName: string,
    subscriptionName: string,
    options: { autoDeleteOnIdle: string; defaultMessageTimeToLive: string },
  ): Promise<unknown>;
  deleteSubscription(topicName: string, subscriptionName: string): Promise<unknown>;
}

/**
 * Consecutive receive errors tolerated before the receiver is declared
 * dead. Transient blips (a brief network wobble) recover on their own and
 * reset this; a sustained run means the subscription is gone or the node is
 * partitioned past the message TTL, at which point continuing to run is
 * silent divergence.
 */
const MAX_CONSECUTIVE_RECEIVE_ERRORS = 10;

/** Service Bus error codes/markers that mean the subscription no longer exists — unrecoverable without re-creating it (i.e. a restart). */
function isEntityGone(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === 'MessagingEntityNotFound') return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && /entity.*not.*found|no longer exists/i.test(message);
}

/**
 * Azure Service Bus topic/subscription fan-out: one topic shared by every
 * BackendCache node, one subscription per node (the standard Service Bus
 * pattern for "every subscriber sees every message", as opposed to a
 * queue's competing-consumers semantics). The subscription is created
 * on-demand at startup and named after this node's id, since Container
 * Apps replicas are ephemeral — a fixed set of subscriptions provisioned
 * up front wouldn't track scale-out/scale-in. `autoDeleteOnIdle` bounds
 * the blast radius if a node dies without the chance to deregister on
 * SIGTERM (stop() below deletes it explicitly on a clean shutdown).
 */
export class ServiceBusReplicationTransport implements ReplicationTransport {
  readonly kind = 'servicebus' as const;
  private readonly subscriptionName: string;
  private client?: ServiceBusClientLike;
  private adminClient?: ServiceBusAdministrationClientLike;
  private sender?: ServiceBusSenderLike;
  private receiver?: ServiceBusReceiverLike;
  private consecutiveReceiveErrors = 0;
  private fatalNotified = false;

  constructor(private readonly cfg: ServiceBusConfig) {
    this.subscriptionName = `node-${cfg.nodeId}`.slice(0, 50);
  }

  async start(onMessage: (event: ReplicationEvent) => void, onFatal?: (err: Error) => void): Promise<void> {
    const { ServiceBusClient, ServiceBusAdministrationClient } = await import('@azure/service-bus');

    // Prefer managed identity (AAD via DefaultAzureCredential + namespace
    // host) over a SAS connection string, mirroring the Cosmos layer — no
    // broad secret to store/rotate, and the topic Send/Manage grant is
    // scoped by RBAC to this identity. Fall back to the connection string
    // when only that is configured.
    const { adminClient, client } = this.cfg.connectionString
      ? {
          adminClient: new ServiceBusAdministrationClient(this.cfg.connectionString) as ServiceBusAdministrationClientLike,
          client: new ServiceBusClient(this.cfg.connectionString) as ServiceBusClientLike,
        }
      : await (async () => {
          const { DefaultAzureCredential } = await import('@azure/identity');
          const credential = new DefaultAzureCredential();
          const namespace = this.cfg.fullyQualifiedNamespace as string;
          return {
            adminClient: new ServiceBusAdministrationClient(namespace, credential) as ServiceBusAdministrationClientLike,
            client: new ServiceBusClient(namespace, credential) as ServiceBusClientLike,
          };
        })();

    if (!(await adminClient.topicExists(this.cfg.topicName))) {
      await adminClient.createTopic(this.cfg.topicName);
    }
    if (!(await adminClient.subscriptionExists(this.cfg.topicName, this.subscriptionName))) {
      await adminClient.createSubscription(this.cfg.topicName, this.subscriptionName, {
        autoDeleteOnIdle: 'PT1H',
        defaultMessageTimeToLive: 'PT5M',
      });
    }
    this.adminClient = adminClient;

    const receiver = client.createReceiver(this.cfg.topicName, this.subscriptionName, { receiveMode: 'receiveAndDelete' });
    this.client = client;
    this.sender = client.createSender(this.cfg.topicName);
    this.receiver = receiver;

    const signalFatal = (err: Error, reason: string): void => {
      if (this.fatalNotified) return;
      this.fatalNotified = true;
      logger.error('cluster.servicebus.fatal', { reason, error: err.message, subscription: this.subscriptionName });
      onFatal?.(err);
    };

    receiver.subscribe({
      processMessage: async (message) => {
        this.consecutiveReceiveErrors = 0; // a delivered message proves the receiver is healthy
        const event = message.body as ReplicationEvent;
        if (event && event.originNodeId !== this.cfg.nodeId) onMessage(event);
      },
      processError: async (args) => {
        // A vanished subscription is unrecoverable in place — the restart
        // re-creates it (and re-hydrates). Treat it, and a sustained run of
        // receive errors, as fatal so the node exits rather than diverging
        // silently. `receiveAndDelete` means anything missed while broken is
        // simply lost, so "keep logging and hope" is the wrong default.
        if (isEntityGone(args.error)) {
          signalFatal(args.error, 'subscription_not_found');
          return;
        }
        if (args.errorSource === 'receive' || args.errorSource === 'receiveAndDelete') {
          this.consecutiveReceiveErrors++;
          if (this.consecutiveReceiveErrors >= MAX_CONSECUTIVE_RECEIVE_ERRORS) {
            signalFatal(args.error, 'sustained_receive_errors');
            return;
          }
        }
        logger.warn('cluster.servicebus.receive_error', {
          error: args.error.message,
          source: args.errorSource,
          consecutive: this.consecutiveReceiveErrors,
        });
      },
    });

    logger.info('cluster.servicebus.started', { topic: this.cfg.topicName, subscription: this.subscriptionName });
  }

  async publish(event: ReplicationEvent): Promise<void> {
    if (!this.sender) throw new Error('ServiceBusReplicationTransport.publish called before start()');
    await this.sender.sendMessages({ body: event, contentType: 'application/json' });
  }

  async stop(): Promise<void> {
    await this.receiver?.close();
    await this.sender?.close();
    await this.client?.close();
    try {
      await this.adminClient?.deleteSubscription(this.cfg.topicName, this.subscriptionName);
    } catch (err) {
      logger.warn('cluster.servicebus.deregister_failed', { error: errorMessage(err) });
    }
  }
}
