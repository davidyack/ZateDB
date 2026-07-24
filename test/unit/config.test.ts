import { describe, expect, it } from 'vitest';
import { isHaConfigured, loadConfig } from '../../src/config.js';

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
    expect(config.shutdownHardLimitMs).toBe(10_000);
    expect(config.maxFailedAuthAttempts).toBe(5);
    expect(config.tcpKeepAliveMs).toBe(30_000);
  });

  it('reads TCP_KEEPALIVE_MS from the env', () => {
    expect(loadConfig({ TCP_KEEPALIVE_MS: '15000' } as unknown as NodeJS.ProcessEnv).tcpKeepAliveMs).toBe(15_000);
  });

  it('falls back to the default when a numeric env value is not a number', () => {
    const config = loadConfig({ RESP_PORT: 'not-a-port' } as unknown as NodeJS.ProcessEnv);
    expect(config.respPort).toBe(6379);
  });

  it('parses REQUIRE_HA as a strict boolean (only literal "true" enables it)', () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).requireHa).toBe(false);
    expect(loadConfig({ REQUIRE_HA: 'true' } as unknown as NodeJS.ProcessEnv).requireHa).toBe(true);
    expect(loadConfig({ REQUIRE_HA: 'TRUE' } as unknown as NodeJS.ProcessEnv).requireHa).toBe(true);
    // Anything that isn't "true" leaves it off — a fat-fingered value must
    // never accidentally *relax* the guard, but also never silently enable it.
    expect(loadConfig({ REQUIRE_HA: 'false' } as unknown as NodeJS.ProcessEnv).requireHa).toBe(false);
    expect(loadConfig({ REQUIRE_HA: '1' } as unknown as NodeJS.ProcessEnv).requireHa).toBe(false);
    expect(loadConfig({ REQUIRE_HA: '' } as unknown as NodeJS.ProcessEnv).requireHa).toBe(false);
  });
});

describe('isHaConfigured', () => {
  it('is false with no cluster env vars set (standalone mode)', () => {
    expect(isHaConfigured(loadConfig({} as NodeJS.ProcessEnv))).toBe(false);
  });

  it('is false when only Cosmos DB is configured (no Service Bus)', () => {
    const config = loadConfig({ COSMOS_CONNECTION_STRING: 'AccountEndpoint=https://x;AccountKey=y' } as unknown as NodeJS.ProcessEnv);
    expect(isHaConfigured(config)).toBe(false);
  });

  it('is false when only Service Bus is configured (no Cosmos DB)', () => {
    const config = loadConfig({ SERVICE_BUS_CONNECTION_STRING: 'Endpoint=sb://x' } as unknown as NodeJS.ProcessEnv);
    expect(isHaConfigured(config)).toBe(false);
  });

  it('is true once both a durable store and a replication transport are configured', () => {
    const config = loadConfig({
      COSMOS_CONNECTION_STRING: 'AccountEndpoint=https://x;AccountKey=y',
      SERVICE_BUS_CONNECTION_STRING: 'Endpoint=sb://x',
    } as unknown as NodeJS.ProcessEnv);
    expect(isHaConfigured(config)).toBe(true);
  });

  it('also accepts a Cosmos endpoint (AAD auth) in place of a connection string', () => {
    const config = loadConfig({
      COSMOS_ENDPOINT: 'https://x.documents.azure.com',
      SERVICE_BUS_CONNECTION_STRING: 'Endpoint=sb://x',
    } as unknown as NodeJS.ProcessEnv);
    expect(isHaConfigured(config)).toBe(true);
  });

  it('accepts a Service Bus namespace (managed identity) in place of a connection string', () => {
    const config = loadConfig({
      COSMOS_ENDPOINT: 'https://x.documents.azure.com',
      SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE: 'my-ns.servicebus.windows.net',
    } as unknown as NodeJS.ProcessEnv);
    expect(config.serviceBusFullyQualifiedNamespace).toBe('my-ns.servicebus.windows.net');
    expect(isHaConfigured(config)).toBe(true); // fully managed-identity HA, no secrets
  });
});
