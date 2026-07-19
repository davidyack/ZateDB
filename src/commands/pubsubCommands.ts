import { array, bulk, integer } from '../resp/types.js';
import type { RespValue } from '../resp/types.js';
import type { CommandContext, CommandResult } from './context.js';
import { wrongArgsError } from './errors.js';
import { recordSubscriptionChange, recordSubscriptionLifecycleEvent } from '../telemetry/commandTelemetry.js';

function confirmation(kind: string, name: string | null, count: number): RespValue {
  return array([bulk(kind), name === null ? bulk(null) : bulk(name), integer(count)]);
}

export function publish(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length !== 2) return { frames: [wrongArgsError('publish')] };
  const [channel, message] = args;
  const reached = ctx.pubsub.publish(channel, message);
  return { frames: [integer(reached)] };
}

export function subscribe(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length < 1) return { frames: [wrongArgsError('subscribe')] };
  const frames: RespValue[] = [];
  for (const channel of args) {
    if (ctx.pubsub.subscribeChannel(ctx.conn, channel)) {
      recordSubscriptionChange('channel', 1);
      recordSubscriptionLifecycleEvent('subscription.added', { connectionId: ctx.conn.id, kind: 'channel', channel });
    }
    ctx.conn.mode = 'subscriber';
    frames.push(confirmation('subscribe', channel, ctx.conn.totalSubscriptions()));
  }
  return { frames };
}

export function psubscribe(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length < 1) return { frames: [wrongArgsError('psubscribe')] };
  const frames: RespValue[] = [];
  for (const pattern of args) {
    if (ctx.pubsub.subscribePattern(ctx.conn, pattern)) {
      recordSubscriptionChange('pattern', 1);
      recordSubscriptionLifecycleEvent('subscription.added', { connectionId: ctx.conn.id, kind: 'pattern', pattern });
    }
    ctx.conn.mode = 'subscriber';
    frames.push(confirmation('psubscribe', pattern, ctx.conn.totalSubscriptions()));
  }
  return { frames };
}

export function unsubscribe(ctx: CommandContext, args: string[]): CommandResult {
  const frames: RespValue[] = [];
  const channels = args.length > 0 ? args : ctx.pubsub.subscribedChannels(ctx.conn);
  if (channels.length === 0) {
    frames.push(confirmation('unsubscribe', null, ctx.conn.totalSubscriptions()));
  } else {
    for (const channel of channels) {
      if (ctx.pubsub.unsubscribeChannel(ctx.conn, channel)) {
        recordSubscriptionChange('channel', -1);
        recordSubscriptionLifecycleEvent('subscription.removed', { connectionId: ctx.conn.id, kind: 'channel', channel });
      }
      frames.push(confirmation('unsubscribe', channel, ctx.conn.totalSubscriptions()));
    }
  }
  if (ctx.conn.totalSubscriptions() === 0) ctx.conn.mode = 'command';
  return { frames };
}

export function punsubscribe(ctx: CommandContext, args: string[]): CommandResult {
  const frames: RespValue[] = [];
  const patterns = args.length > 0 ? args : ctx.pubsub.subscribedPatterns(ctx.conn);
  if (patterns.length === 0) {
    frames.push(confirmation('punsubscribe', null, ctx.conn.totalSubscriptions()));
  } else {
    for (const pattern of patterns) {
      if (ctx.pubsub.unsubscribePattern(ctx.conn, pattern)) {
        recordSubscriptionChange('pattern', -1);
        recordSubscriptionLifecycleEvent('subscription.removed', { connectionId: ctx.conn.id, kind: 'pattern', pattern });
      }
      frames.push(confirmation('punsubscribe', pattern, ctx.conn.totalSubscriptions()));
    }
  }
  if (ctx.conn.totalSubscriptions() === 0) ctx.conn.mode = 'command';
  return { frames };
}
