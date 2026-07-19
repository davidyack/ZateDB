import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  it('reads every value from the supplied env, not the ambient process.env', () => {
    // Regression: intFromEnv used to read process.env directly, so ports and
    // the sweep interval ignored the env passed to loadConfig while string
    // values honored it — an inconsistency that broke isolated configuration.
    const env = {
      RESP_PORT: '7000',
      HEALTH_PORT: '7001',
      ADMIN_PORT: '7002',
      TTL_SWEEP_INTERVAL_MS: '1234',
      REDIS_AUTH_PASSWORD: 'pw',
      ADMIN_TOKEN: 'tok',
    } as unknown as NodeJS.ProcessEnv;

    const config = loadConfig(env);

    expect(config.respPort).toBe(7000);
    expect(config.healthPort).toBe(7001);
    expect(config.adminPort).toBe(7002);
    expect(config.ttlSweepIntervalMs).toBe(1234);
    expect(config.authPassword).toBe('pw');
    expect(config.adminToken).toBe('tok');
  });

  it('falls back to defaults when the supplied env omits a value', () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    expect(config.respPort).toBe(6379);
    expect(config.healthPort).toBe(8081);
    expect(config.adminPort).toBe(8082);
    expect(config.ttlSweepIntervalMs).toBe(5000);
    expect(config.authPassword).toBeNull();
    expect(config.adminToken).toBeNull();
  });

  it('falls back to the default when a numeric env value is not a number', () => {
    const config = loadConfig({ RESP_PORT: 'not-a-port' } as unknown as NodeJS.ProcessEnv);
    expect(config.respPort).toBe(6379);
  });
});
