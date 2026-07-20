import { describe, expect, it } from 'vitest';
import { auth } from '../../src/commands/connectionCommands.js';
import type { CommandContext, ConnectionContext } from '../../src/commands/context.js';
import { loadConfig } from '../../src/config.js';

function ctxWith(env: Record<string, string>, conn: Partial<ConnectionContext> = {}): CommandContext {
  const connection: ConnectionContext = {
    id: 'c1',
    authenticated: false,
    failedAuthCount: 0,
    mode: 'command',
    clientName: null,
    remoteAddress: '127.0.0.1:0',
    sendMessage() {},
    sendPMessage() {},
    totalSubscriptions: () => 0,
    ...conn,
  };
  return {
    store: null as never,
    pubsub: null as never,
    cluster: null as never,
    conn: connection,
    config: loadConfig({ REDIS_AUTH_PASSWORD: 'secret', ...env } as unknown as NodeJS.ProcessEnv),
  };
}

describe('failed-AUTH throttling', () => {
  it('closes the connection only once the failure threshold is reached', () => {
    const ctx = ctxWith({ MAX_FAILED_AUTH_ATTEMPTS: '3' });

    let r = auth(ctx, ['wrong']);
    expect(ctx.conn.failedAuthCount).toBe(1);
    expect(r.closeAfter).toBeFalsy(); // still gives the client another go
    expect(r.frames[0].type).toBe('error');

    r = auth(ctx, ['wrong']);
    expect(ctx.conn.failedAuthCount).toBe(2);
    expect(r.closeAfter).toBeFalsy();

    r = auth(ctx, ['wrong']);
    expect(ctx.conn.failedAuthCount).toBe(3);
    expect(r.closeAfter).toBe(true); // third strike drops the socket
  });

  it('resets the counter on a successful AUTH', () => {
    const ctx = ctxWith({ MAX_FAILED_AUTH_ATTEMPTS: '3' });
    auth(ctx, ['wrong']);
    auth(ctx, ['wrong']);
    expect(ctx.conn.failedAuthCount).toBe(2);

    const ok = auth(ctx, ['secret']);
    expect(ok.frames[0]).toEqual({ type: 'simple', value: 'OK' });
    expect(ctx.conn.authenticated).toBe(true);
    expect(ctx.conn.failedAuthCount).toBe(0); // a good password clears the streak
  });

  it('never closes when throttling is disabled (0)', () => {
    const ctx = ctxWith({ MAX_FAILED_AUTH_ATTEMPTS: '0' });
    for (let i = 0; i < 20; i++) {
      const r = auth(ctx, ['wrong']);
      expect(r.closeAfter).toBeFalsy();
    }
    expect(ctx.conn.failedAuthCount).toBe(20);
  });
});
