import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindSlowCommandThreshold, traceCommand } from '../../src/telemetry/commandTelemetry.js';
import { logger } from '../../src/logger.js';
import type { DispatchOutcome } from '../../src/commands/dispatcher.js';

function outcome(isError = false): DispatchOutcome {
  return { command: 'GET', frames: [], isError };
}

describe('slow-command log', () => {
  afterEach(() => {
    bindSlowCommandThreshold(0); // reset to disabled
    vi.restoreAllMocks();
  });

  it('logs a command that meets the threshold, with a redacted key', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    bindSlowCommandThreshold(0.0001); // effectively "log everything"

    traceCommand('GET', 'conn-1', 'user:secret@example.com', () => outcome());

    expect(warn).toHaveBeenCalledWith('command.slow', expect.objectContaining({ command: 'GET', result: 'success' }));
    const fields = warn.mock.calls[0][1] as { key: string; durationMs: number };
    expect(fields.key).not.toContain('secret@example.com'); // redacted, not the raw key
    expect(typeof fields.durationMs).toBe('number');
  });

  it('does not log when disabled (threshold 0)', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    bindSlowCommandThreshold(0);
    traceCommand('GET', 'conn-1', 'k', () => outcome());
    expect(warn).not.toHaveBeenCalledWith('command.slow', expect.anything());
  });

  it('does not log a fast command below a high threshold', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    bindSlowCommandThreshold(10_000); // 10s — a synchronous no-op won't reach it
    traceCommand('GET', 'conn-1', 'k', () => outcome());
    expect(warn).not.toHaveBeenCalledWith('command.slow', expect.anything());
  });
});
