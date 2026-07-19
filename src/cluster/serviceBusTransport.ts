import type { ReplicationTransport } from './replicationTransport.js';
import type { ReplicationEvent } from './types.js';
import { errorMessage, logger } from '../logger.js';

export interface ServiceBusConfig {
  connectionString: string;
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

  constructor(private readonly cfg: ServiceBusConfig) {
    this.subscriptionName = `node-${cfg.nodeId}`.slice(0, 50);
  }

  async start(onMessage: (event: ReplicationEvent) => void): Promise<void> {
    const { ServiceBusClient, ServiceBusAdministrationClient } = await import('@azure/service-bus');

    const adminClient: ServiceBusAdministrationClientLike = new ServiceBusAdministrationClient(this.cfg.connectionString);
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

    const client: ServiceBusClientLike = new ServiceBusClient(this.cfg.connectionString);
    const receiver = client.createReceiver(this.cfg.topicName, this.subscriptionName, { receiveMode: 'receiveAndDelete' });
    this.client = client;
    this.sender = client.createSender(this.cfg.topicName);
    this.receiver = receiver;

    receiver.subscribe({
      processMessage: async (message) => {
        const event = message.body as ReplicationEvent;
        if (event && event.originNodeId !== this.cfg.nodeId) onMessage(event);
      },
      processError: async (args) => {
        logger.warn('cluster.servicebus.receive_error', { error: args.error.message, source: args.errorSource });
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
