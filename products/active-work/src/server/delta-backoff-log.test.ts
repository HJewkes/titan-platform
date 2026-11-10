import { describe, expect, it, vi } from 'vitest';
import { deltaBackoffLog } from './delta-backoff-log.js';

function setup() {
  const log = { info: vi.fn(), warn: vi.fn() };
  const controller = new AbortController();
  const backoff = deltaBackoffLog(log, controller.signal);
  return { log, controller, backoff };
}

describe('deltaBackoffLog', () => {
  it('logs the backoff the scheduler reports for a failed delta', () => {
    const { log, backoff } = setup();
    const err = new Error('corpus unreadable');

    backoff.onError(err, { kind: 'delta', backoffMs: 4_000 });

    expect(log.warn).toHaveBeenCalledWith(
      { err, backoffMs: 4_000 },
      'session index delta failed; backing off',
    );
  });

  it('logs a failed full pass without a backoff', () => {
    const { log, backoff } = setup();
    const err = new Error('corpus unreadable');

    backoff.onError(err, { kind: 'full', backoffMs: 1_000 });

    expect(log.warn).toHaveBeenCalledWith({ err }, 'session index refresh failed');
  });

  it('logs recovery once after a failed delta and not after a plain success', async () => {
    const { log, backoff } = setup();
    const run = backoff.wrap(async () => 'ok');

    await run('delta', () => {}, () => {});
    backoff.onError(new Error('x'), { kind: 'delta', backoffMs: 1_000 });
    await run('delta', () => {}, () => {});
    await run('delta', () => {}, () => {});

    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it('stays quiet once the daemon is shutting down', () => {
    const { log, controller, backoff } = setup();
    controller.abort();

    backoff.onError(new Error('x'), { kind: 'delta', backoffMs: 1_000 });

    expect(log.warn).not.toHaveBeenCalled();
  });
});
