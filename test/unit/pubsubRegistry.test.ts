import { describe, expect, it } from 'vitest';
import { PubSubRegistry } from '../../src/pubsub/registry.js';
import type { Subscriber } from '../../src/pubsub/registry.js';

function fakeSubscriber(id: string): Subscriber & { messages: Array<[string, string]>; pmessages: Array<[string, string, string]> } {
  const messages: Array<[string, string]> = [];
  const pmessages: Array<[string, string, string]> = [];
  return {
    id,
    messages,
    pmessages,
    sendMessage(channel, message) {
      messages.push([channel, message]);
    },
    sendPMessage(pattern, channel, message) {
      pmessages.push([pattern, channel, message]);
    },
  };
}

describe('PubSubRegistry', () => {
  it('delivers PUBLISH to exact-match channel subscribers', () => {
    const registry = new PubSubRegistry();
    const sub = fakeSubscriber('a');
    registry.subscribeChannel(sub, 'room:1');
    const reached = registry.publish('room:1', 'hello');
    expect(reached).toBe(1);
    expect(sub.messages).toEqual([['room:1', 'hello']]);
  });

  it('does not deliver to a channel with no subscribers', () => {
    const registry = new PubSubRegistry();
    expect(registry.publish('nobody-listening', 'msg')).toBe(0);
  });

  it('delivers to multiple subscribers of the same channel', () => {
    const registry = new PubSubRegistry();
    const a = fakeSubscriber('a');
    const b = fakeSubscriber('b');
    registry.subscribeChannel(a, 'room:1');
    registry.subscribeChannel(b, 'room:1');
    expect(registry.publish('room:1', 'hi')).toBe(2);
  });

  it('delivers PUBLISH to matching pattern subscribers via PSUBSCRIBE', () => {
    const registry = new PubSubRegistry();
    const sub = fakeSubscriber('a');
    registry.subscribePattern(sub, 'room:*');
    registry.publish('room:42', 'hello');
    expect(sub.pmessages).toEqual([['room:*', 'room:42', 'hello']]);
  });

  it('a channel subscriber and a matching pattern subscriber both receive one PUBLISH', () => {
    const registry = new PubSubRegistry();
    const exact = fakeSubscriber('exact');
    const patterned = fakeSubscriber('patterned');
    registry.subscribeChannel(exact, 'room:1');
    registry.subscribePattern(patterned, 'room:*');
    expect(registry.publish('room:1', 'hi')).toBe(2);
  });

  it('unsubscribeChannel stops delivery', () => {
    const registry = new PubSubRegistry();
    const sub = fakeSubscriber('a');
    registry.subscribeChannel(sub, 'room:1');
    registry.unsubscribeChannel(sub, 'room:1');
    expect(registry.publish('room:1', 'hi')).toBe(0);
  });

  it('unsubscribeAll removes every channel and pattern subscription for a connection (disconnect cleanup)', () => {
    const registry = new PubSubRegistry();
    const sub = fakeSubscriber('a');
    registry.subscribeChannel(sub, 'room:1');
    registry.subscribeChannel(sub, 'room:2');
    registry.subscribePattern(sub, 'room:*');

    registry.unsubscribeAll(sub);

    expect(registry.publish('room:1', 'hi')).toBe(0);
    expect(registry.publish('room:2', 'hi')).toBe(0);
    const stats = registry.stats();
    expect(stats.channelCount).toBe(0);
    expect(stats.patternCount).toBe(0);
  });

  it('a dropped connection cannot leave a dangling registry entry that a later publish would hit', () => {
    const registry = new PubSubRegistry();
    const sub = fakeSubscriber('a');
    registry.subscribeChannel(sub, 'room:1');
    registry.unsubscribeAll(sub); // simulates the connection manager's onClose cleanup
    expect(registry.subscribedChannels(sub)).toEqual([]);
    expect(registry.stats().channelSubscriptions).toBe(0);
  });

  it('supports Redis glob syntax in patterns (?, [...])', () => {
    const registry = new PubSubRegistry();
    const sub = fakeSubscriber('a');
    registry.subscribePattern(sub, 'room:[12]');
    registry.publish('room:1', 'a');
    registry.publish('room:3', 'b'); // should not match
    registry.publish('room:2', 'c');
    expect(sub.pmessages.map((m) => m[1])).toEqual(['room:1', 'room:2']);
  });

  it('reports topology for the admin pubsub endpoint', () => {
    const registry = new PubSubRegistry();
    const a = fakeSubscriber('a');
    const b = fakeSubscriber('b');
    registry.subscribeChannel(a, 'room:1');
    registry.subscribeChannel(b, 'room:1');
    registry.subscribePattern(a, 'room:*');
    const topo = registry.topology();
    expect(topo.channels).toEqual([{ channel: 'room:1', subscriberCount: 2 }]);
    expect(topo.patterns).toEqual([{ pattern: 'room:*', subscriberCount: 1 }]);
  });
});
