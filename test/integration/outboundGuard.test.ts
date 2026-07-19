import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import type { RedisClientType } from 'redis';
import { randomUUID } from 'node:crypto';
import { startTestServer } from '../helpers/startServer.js';
import type { TestServer } from '../helpers/startServer.js';

/**
 * Regression test for the gap the design spec's revision called out
 * explicitly (§4, §13.2): the first draft's command surface missed the
 * sorted-set commands (ZADD/ZREMRANGEBYSCORE/ZCOUNT) plus SET PX/GET/DEL
 * used by the outbound-email abuse guard's cooldown and sliding-window
 * caps. This mirrors that service's actual usage pattern — a per-recipient
 * cooldown timestamp, a per-ticket auto-reply counter, and a per-workspace
 * sliding-window send log — against a real node-redis client, using the
 * exact ZCOUNT range-argument syntax that service sends
 * (`(${now - windowMs}`, '+inf').
 */
describe('outbound-email abuse guard sliding-window pattern (spec §4/§13.2 regression)', () => {
  let server: TestServer;
  let client: RedisClientType;

  beforeAll(async () => {
    server = await startTestServer();
    client = createClient({ url: server.url });
    await client.connect();
  });

  afterAll(async () => {
    await client.quit();
    await server.stop();
  });

  function recipientCooldownKey(workspaceId: string, recipient: string): string {
    return `guard:cooldown:${workspaceId}:${recipient}`;
  }

  function ticketAutoReplyKey(workspaceId: string, ticketId: string): string {
    return `guard:ticket-autoreply:${workspaceId}:${ticketId}`;
  }

  function workspaceSendLogKey(workspaceId: string): string {
    return `guard:sends:${workspaceId}`;
  }

  it('per-recipient cooldown: SET PX blocks a second send until it expires', async () => {
    const workspaceId = 'ws-1';
    const recipient = 'someone@example.com';
    const key = recipientCooldownKey(workspaceId, recipient);
    const cooldownMs = 80;

    // First send: no cooldown set yet -> allowed, then set a cooldown marker.
    expect(await client.get(key)).toBeNull();
    await client.set(key, String(Date.now()), { PX: cooldownMs });

    // Second send attempted immediately: cooldown marker still present -> blocked.
    expect(await client.get(key)).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, cooldownMs + 30));

    // Cooldown expired -> allowed again.
    expect(await client.get(key)).toBeNull();
  });

  it('per-recipient cooldown can be cleared early with DEL (e.g. manual override)', async () => {
    const key = recipientCooldownKey('ws-1', 'other@example.com');
    await client.set(key, String(Date.now()), { PX: 60_000 });
    expect(await client.get(key)).not.toBeNull();
    await client.del(key);
    expect(await client.get(key)).toBeNull();
  });

  it('per-ticket auto-reply cap: INCR + PEXPIRE enforces a max count per ticket', async () => {
    const key = ticketAutoReplyKey('ws-1', 'ticket-42');
    const maxAutoReplies = 3;
    const windowMs = 60_000;

    const counts: number[] = [];
    for (let i = 0; i < maxAutoReplies + 2; i++) {
      const count = await client.incr(key);
      await client.pExpire(key, windowMs, 'NX');
      counts.push(count);
    }

    expect(counts).toEqual([1, 2, 3, 4, 5]);
    const allowed = counts.map((c) => c <= maxAutoReplies);
    expect(allowed).toEqual([true, true, true, false, false]);
  });

  it('workspace sliding-window cap: ZADD + ZREMRANGEBYSCORE + ZCOUNT with the exact range syntax the guard sends', async () => {
    const workspaceId = 'ws-sliding';
    const key = workspaceSendLogKey(workspaceId);
    const now = Date.now();
    const oneMinuteMs = 60_000;
    const oneDayMs = 24 * 60 * 60 * 1000;

    // Seed the log with sends spread across the last day, including some
    // that should already be outside both the minute and day windows.
    const events: Array<[number, string]> = [
      [now - oneDayMs - 5_000, randomUUID()], // older than the day window -> pruned
      [now - oneDayMs + 5_000, randomUUID()], // within the day window, outside the minute window
      [now - 30_000, randomUUID()], // within the minute window
      [now - 1_000, randomUUID()], // within the minute window
    ];
    for (const [score, id] of events) {
      await client.zAdd(key, [{ score, value: `${score}:${id}` }]);
    }

    // Prune anything older than the tracked (day) window — mirrors the
    // guard's pruning call: ZREMRANGEBYSCORE key 0 (now - dayWindowMs)
    const pruned = await client.zRemRangeByScore(key, 0, now - oneDayMs);
    expect(pruned).toBe(1);

    // Per-minute cap check: ZCOUNT key "(<now-60000>" "+inf"
    const perMinuteCount = await client.zCount(key, `(${now - oneMinuteMs}`, '+inf');
    expect(perMinuteCount).toBe(2);

    // Per-day cap check: ZCOUNT key "(<now-oneDayMs>" "+inf"
    const perDayCount = await client.zCount(key, `(${now - oneDayMs}`, '+inf');
    expect(perDayCount).toBe(3);

    // Record a new send the way the guard would after the cap check passes.
    const newEventId = `${now}:${randomUUID()}`;
    expect(await client.zAdd(key, [{ score: now, value: newEventId }])).toBe(1);
    expect(await client.zCount(key, `(${now - oneMinuteMs}`, '+inf')).toBe(3);
  });

  it('a workspace at its per-minute cap is correctly identified as blocked', async () => {
    const key = workspaceSendLogKey('ws-at-cap');
    const now = Date.now();
    const perMinuteCap = 5;

    for (let i = 0; i < perMinuteCap; i++) {
      await client.zAdd(key, [{ score: now - i * 1000, value: `${now}-${i}-${randomUUID()}` }]);
    }

    const count = await client.zCount(key, `(${now - 60_000}`, '+inf');
    expect(count).toBe(perMinuteCap);
    const wouldBlock = count >= perMinuteCap;
    expect(wouldBlock).toBe(true);
  });
});
