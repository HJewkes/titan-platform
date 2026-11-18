import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@titan-design/daemon';
import { startPrecedentWatch, type PrecedentExtract } from './precedent-watch.js';

const INTERVAL = 60_000;

function fakeLogger(): { log: Logger; info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  const info = vi.fn();
  const error = vi.fn();
  const log: Logger = { info, error, warn: vi.fn() };
  return { log, info, error };
}

function okExtract(): ReturnType<typeof vi.fn<PrecedentExtract>> {
  return vi.fn<PrecedentExtract>(() =>
    Promise.resolve({ sources: [{ source: 'notes', written: 2, errors: ['bad'] }] }),
  );
}

describe('startPrecedentWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs one pass shortly after start, then one per interval', async () => {
    const extract = okExtract();
    const { log } = fakeLogger();
    const watch = startPrecedentWatch(log, { extract, intervalMs: INTERVAL, startDelayMs: 1000 });
    expect(extract).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(extract).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(extract).toHaveBeenCalledTimes(2);
    await watch?.close();
  });

  it('logs one line per pass with per-source added and error counts', async () => {
    const extract = okExtract();
    const { log, info } = fakeLogger();
    const watch = startPrecedentWatch(log, { extract, intervalMs: INTERVAL, startDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(0);

    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toEqual({ sources: [{ source: 'notes', added: 2, errors: 1 }] });
    await watch?.close();
  });

  it('skips a tick while a pass is still running', async () => {
    let release: () => void = () => undefined;
    const extract = vi.fn<PrecedentExtract>(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ sources: [] });
        }),
    );
    const { log } = fakeLogger();
    const watch = startPrecedentWatch(log, { extract, intervalMs: INTERVAL, startDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(extract).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(extract).toHaveBeenCalledTimes(2);
    release();
    await watch?.close();
  });

  it('logs a throwing extract and still runs the next tick', async () => {
    const extract = vi
      .fn<PrecedentExtract>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ sources: [] });
    const { log, error } = fakeLogger();
    const watch = startPrecedentWatch(log, { extract, intervalMs: INTERVAL, startDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(extract).toHaveBeenCalledTimes(2);
    await watch?.close();
  });

  it('starts nothing when AW_PRECEDENT_EXTRACT_MS is 0', async () => {
    vi.stubEnv('AW_PRECEDENT_EXTRACT_MS', '0');
    const extract = okExtract();
    const { log } = fakeLogger();
    const watch = startPrecedentWatch(log, { extract, startDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(10 * INTERVAL);

    expect(watch).toBeNull();
    expect(extract).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('stops further passes after close()', async () => {
    const extract = okExtract();
    const { log } = fakeLogger();
    const watch = startPrecedentWatch(log, { extract, intervalMs: INTERVAL, startDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await watch?.close();
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);

    expect(extract).toHaveBeenCalledTimes(1);
  });
});
