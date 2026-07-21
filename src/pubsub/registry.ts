import { globToRegExp } from './glob.js';

export interface Subscriber {
  id: string;
  sendMessage(channel: string, message: string): void;
  sendPMessage(pattern: string, channel: string, message: string): void;
}

interface PatternEntry {
  regex: RegExp;
  subscribers: Set<Subscriber>;
}

export interface PubSubStats {
  channelCount: number;
  patternCount: number;
  channelSubscriptions: number;
  patternSubscriptions: number;
}

export interface PubSubTopology {
  channels: Array<{ channel: string; subscriberCount: number }>;
  patterns: Array<{ pattern: string; subscriberCount: number }>;
}

/**
 * Tracks channel and pattern subscriptions and fans out PUBLISH calls.
 * Delivery is best-effort and synchronous, matching real Redis pub/sub:
 * no queueing, no persistence, no delivery guarantee beyond "the
 * subscriber connection is alive right now".
 */
export class PubSubRegistry {
  private channels = new Map<string, Set<Subscriber>>();
  private patterns = new Map<string, PatternEntry>();
  // reverse index for O(1) cleanup on disconnect
  private subscriberChannels = new Map<string, Set<string>>();
  private subscriberPatterns = new Map<string, Set<string>>();

  /** Returns true if this was a new subscription (not an already-held one). */
  subscribeChannel(sub: Subscriber, channel: string): boolean {
    let set = this.channels.get(channel);
    if (!set) {
      set = new Set();
      this.channels.set(channel, set);
    }
    if (set.has(sub)) return false;
    set.add(sub);
    this.trackReverse(this.subscriberChannels, sub.id, channel);
    return true;
  }

  /** Returns true if a subscription was actually removed. */
  unsubscribeChannel(sub: Subscriber, channel: string): boolean {
    const set = this.channels.get(channel);
    const removed = set?.delete(sub) ?? false;
    if (set && set.size === 0) this.channels.delete(channel);
    this.subscriberChannels.get(sub.id)?.delete(channel);
    return removed;
  }

  /** Returns true if this was a new subscription (not an already-held one). */
  subscribePattern(sub: Subscriber, pattern: string): boolean {
    let entry = this.patterns.get(pattern);
    if (!entry) {
      entry = { regex: globToRegExp(pattern), subscribers: new Set() };
      this.patterns.set(pattern, entry);
    }
    if (entry.subscribers.has(sub)) return false;
    entry.subscribers.add(sub);
    this.trackReverse(this.subscriberPatterns, sub.id, pattern);
    return true;
  }

  /** Returns true if a subscription was actually removed. */
  unsubscribePattern(sub: Subscriber, pattern: string): boolean {
    const entry = this.patterns.get(pattern);
    const removed = entry?.subscribers.delete(sub) ?? false;
    if (entry && entry.subscribers.size === 0) this.patterns.delete(pattern);
    this.subscriberPatterns.get(sub.id)?.delete(pattern);
    return removed;
  }

  /** Removes a subscriber from every channel/pattern it holds. Call on disconnect. */
  unsubscribeAll(sub: Subscriber): void {
    for (const channel of this.subscriberChannels.get(sub.id) ?? []) {
      this.channels.get(channel)?.delete(sub);
      if (this.channels.get(channel)?.size === 0) this.channels.delete(channel);
    }
    for (const pattern of this.subscriberPatterns.get(sub.id) ?? []) {
      this.patterns.get(pattern)?.subscribers.delete(sub);
      if (this.patterns.get(pattern)?.subscribers.size === 0) this.patterns.delete(pattern);
    }
    this.subscriberChannels.delete(sub.id);
    this.subscriberPatterns.delete(sub.id);
  }

  channelSubscriptionCount(sub: Subscriber): number {
    return this.subscriberChannels.get(sub.id)?.size ?? 0;
  }

  patternSubscriptionCount(sub: Subscriber): number {
    return this.subscriberPatterns.get(sub.id)?.size ?? 0;
  }

  subscribedChannels(sub: Subscriber): string[] {
    return Array.from(this.subscriberChannels.get(sub.id) ?? []);
  }

  subscribedPatterns(sub: Subscriber): string[] {
    return Array.from(this.subscriberPatterns.get(sub.id) ?? []);
  }

  /** Delivers to exact-match channel subscribers and pattern subscribers whose pattern matches. Returns count reached. */
  publish(channel: string, message: string): number {
    let reached = 0;
    const exact = this.channels.get(channel);
    if (exact) {
      for (const sub of exact) {
        sub.sendMessage(channel, message);
        reached++;
      }
    }
    for (const [pattern, entry] of this.patterns) {
      if (entry.regex.test(channel)) {
        for (const sub of entry.subscribers) {
          sub.sendPMessage(pattern, channel, message);
          reached++;
        }
      }
    }
    return reached;
  }

  /** Subscriber count for one exact channel — backs PUBSUB NUMSUB. */
  subscriberCountForChannel(channel: string): number {
    return this.channels.get(channel)?.size ?? 0;
  }

  /** Number of distinct active patterns — backs PUBSUB NUMPAT. */
  patternCount(): number {
    return this.patterns.size;
  }

  /** Channel names with at least one subscriber, optionally glob-filtered — backs PUBSUB CHANNELS. */
  activeChannels(pattern?: string): string[] {
    const names = Array.from(this.channels.keys());
    if (pattern === undefined) return names;
    const regex = globToRegExp(pattern);
    return names.filter((name) => regex.test(name));
  }

  stats(): PubSubStats {
    let channelSubscriptions = 0;
    for (const set of this.channels.values()) channelSubscriptions += set.size;
    let patternSubscriptions = 0;
    for (const entry of this.patterns.values()) patternSubscriptions += entry.subscribers.size;
    return {
      channelCount: this.channels.size,
      patternCount: this.patterns.size,
      channelSubscriptions,
      patternSubscriptions,
    };
  }

  topology(): PubSubTopology {
    return {
      channels: Array.from(this.channels.entries()).map(([channel, subs]) => ({
        channel,
        subscriberCount: subs.size,
      })),
      patterns: Array.from(this.patterns.entries()).map(([pattern, entry]) => ({
        pattern,
        subscriberCount: entry.subscribers.size,
      })),
    };
  }

  private trackReverse(map: Map<string, Set<string>>, subId: string, key: string): void {
    let set = map.get(subId);
    if (!set) {
      set = new Set();
      map.set(subId, set);
    }
    set.add(key);
  }
}
