import { describe, expect, it, vi } from 'vitest';
import { RefreshScheduler } from './scheduler.js';
import type { RefreshSummary } from './refresh.js';

const summary: RefreshSummary = {
  kind: 'full',
  startedAt: '2026-07-01T00:00:00Z',
  durationMs: 0,
  transcripts: 0,
  scanned: 0,
  filesOpened: 0,
  bytesRead: 0,
  rowsWritten: 0,
  dbBytes: 0,
  phases: {},
  indexed: 0,
  rewound: 0,
  unchanged: 0,
  quarantined: 0,
  missing: 0,
  reconciledMissing: 0,
  facetsBackfilled: 0,
  facetBacklog: 0,
  episodesWritten: 0,
  episodeBacklog: null,
  factsAdded: 0,
  turnsRolledUp: 0,
  tasksRequested: 0,
  tasksApplied: 0,
  prsPolled: 0,
  workspace: null,
  preserved: { restored: 0, merged: 0, skipped: 0 },
  errors: [],
};

/** A fake clock whose sleep advances time and records each wait. */
function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('RefreshScheduler', () => {
  it('a held gate defers the pass, keeps it pending, and reports one hold and one resume', async () => {
    const clock = fakeClock();
    const run = vi.fn(async () => summary);
    const decisions = [true, true, true, false].map((hold) => ({
      hold,
      reason: hold ? 'swap 70% used' : undefined,
    }));
    const pendingWhileHeld: boolean[] = [];
    const gate = vi.fn(async () => {
      const decision = decisions.shift() ?? { hold: false };
      if (decision.hold)
        pendingWhileHeld.push(scheduler.status().pending && run.mock.calls.length === 0);
      return decision;
    });
    const onHoldChange = vi.fn();
    const scheduler = new RefreshScheduler(run, {
      ...clock,
      gate,
      gateRecheckMs: 60_000,
      onHoldChange,
    });

    scheduler.trigger();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await settle();

    expect(gate).toHaveBeenCalledTimes(4);
    expect(clock.sleeps).toEqual([60_000, 60_000, 60_000]);
    expect(pendingWhileHeld).toEqual([true, true, true]);
    expect(onHoldChange.mock.calls).toEqual([
      [true, 'swap 70% used'],
      [false, undefined],
    ]);
  });

  it('a gate that never opens still lets a pass run after the hold cap, and none before it', async () => {
    const clock = fakeClock();
    const run = vi.fn(async () => summary);
    const onHoldChange = vi.fn();
    const scheduler = new RefreshScheduler(run, {
      ...clock,
      gate: async () => ({ hold: true, reason: 'swap 70% used' }),
      gateRecheckMs: 60_000,
      maxHoldMs: 300_000,
      onHoldChange,
    });

    scheduler.trigger();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    expect(clock.now()).toBe(360_000);
    expect(clock.sleeps).toEqual(Array(6).fill(60_000));
    expect(onHoldChange.mock.calls).toEqual([
      [true, 'swap 70% used'],
      [false, 'hold cap 300000 ms reached'],
    ]);
  });

  it('after a hold-cap release, a reader during the cap pass still reads stale and starts no delta', async () => {
    const clock = fakeClock();
    let finish = (): void => {};
    const run = vi.fn(
      (_kind: string, onIndexed: () => void) =>
        new Promise<RefreshSummary>((resolve) => {
          onIndexed();
          finish = () => resolve(summary);
        }),
    );
    const scheduler = new RefreshScheduler(run, {
      ...clock,
      gate: async () => ({ hold: true, reason: 'swap 70% used' }),
      gateRecheckMs: 60_000,
      maxHoldMs: 300_000,
    });

    scheduler.trigger();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const read = await scheduler.runNow(1_000);

    expect(read).toBe('stale');
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await scheduler.close();
  });

  it('status reports held, holdReason and heldSince through a hold, a reason change and the gate opening', async () => {
    const clock = fakeClock();
    const decisions = [
      { hold: true, reason: 'swap 70% used' },
      { hold: true, reason: 'swap 70% used' },
      { hold: true, reason: 'pressure level 2' },
      { hold: false },
    ];
    const seen: ReturnType<RefreshScheduler['status']>[] = [];
    const gate = vi.fn(async () => {
      seen.push(scheduler.status());
      return decisions.shift() ?? { hold: false };
    });
    const run = vi.fn(async () => {
      seen.push(scheduler.status());
      return summary;
    });
    const scheduler = new RefreshScheduler(run, { ...clock, gate, gateRecheckMs: 60_000 });

    scheduler.trigger();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    const since = new Date(0).toISOString();
    const view = seen.map(({ held, holdReason, heldSince }) => ({ held, holdReason, heldSince }));
    expect(view).toEqual([
      { held: false, holdReason: null, heldSince: null },
      { held: true, holdReason: 'swap 70% used', heldSince: since },
      { held: true, holdReason: 'swap 70% used', heldSince: since },
      { held: true, holdReason: 'pressure level 2', heldSince: since },
      { held: false, holdReason: null, heldSince: null },
    ]);
  });

  it('status stays held after a hold-cap pass because the gate is still closed', async () => {
    const clock = fakeClock();
    let atRun: ReturnType<RefreshScheduler['status']> | null = null;
    const run = vi.fn(async () => {
      atRun = scheduler.status();
      return summary;
    });
    const scheduler = new RefreshScheduler(run, {
      ...clock,
      gate: async () => ({ hold: true, reason: 'swap 70% used' }),
      gateRecheckMs: 60_000,
      maxHoldMs: 300_000,
    });

    scheduler.trigger();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    expect(atRun).toMatchObject({ held: true, holdReason: 'swap 70% used' });
    expect(scheduler.status().held).toBe(true);
  });

  it('collapses triggers that arrive mid-hold into one pass after the resume', async () => {
    const clock = fakeClock();
    const run = vi.fn(async () => summary);
    let holds = 2;
    const gate = vi.fn(async () => {
      if (holds-- > 0) {
        for (let i = 0; i < 5; i++) scheduler.trigger();
        return { hold: true, reason: 'pressure' };
      }
      return { hold: false };
    });
    const scheduler = new RefreshScheduler(run, { ...clock, gate, gateRecheckMs: 60_000 });

    scheduler.trigger();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await settle();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs a pass without a hold report when the gate never holds', async () => {
    const run = vi.fn(async () => summary);
    const onHoldChange = vi.fn();
    const scheduler = new RefreshScheduler(run, {
      gate: async () => ({ hold: false }),
      onHoldChange,
    });

    scheduler.trigger();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    expect(onHoldChange).not.toHaveBeenCalled();
  });

  it('close() ends a hold without running the pass', async () => {
    const run = vi.fn(async () => summary);
    const scheduler = new RefreshScheduler(run, {
      gate: async () => ({ hold: true, reason: 'pressure' }),
      gateRecheckMs: 60_000,
    });

    scheduler.trigger();
    await settle();
    await scheduler.close();

    expect(run).not.toHaveBeenCalled();
  });

  it('runs a burst of 100 triggers as one run plus one trailing run a full window later', async () => {
    const clock = fakeClock();
    const run = vi.fn(async () => summary);
    const scheduler = new RefreshScheduler(run, { ...clock, minIntervalMs: 15_000 });

    for (let i = 0; i < 100; i++) scheduler.trigger();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await settle();

    expect(run).toHaveBeenCalledTimes(2);
    expect(clock.sleeps).toEqual([15_000]);
  });

  it('waits out the interval before a trailing run', async () => {
    const clock = fakeClock();
    const run = vi.fn(async () => {
      if (run.mock.calls.length === 1) scheduler.trigger();
      return summary;
    });
    const scheduler = new RefreshScheduler(run, { ...clock, minIntervalMs: 15_000 });

    scheduler.trigger();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));

    expect(clock.sleeps).toEqual([15_000]);
  });

  it('skips an ELOCKED round without logging an error and retries with backoff', async () => {
    const clock = fakeClock();
    const locked = Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED' });
    const run = vi
      .fn<() => Promise<RefreshSummary>>()
      .mockRejectedValueOnce(locked)
      .mockResolvedValue(summary);
    const onError = vi.fn();
    const onLockSkip = vi.fn();
    const scheduler = new RefreshScheduler(run, {
      ...clock,
      minIntervalMs: 0,
      onError,
      onLockSkip,
    });

    scheduler.trigger();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));

    expect(onError).not.toHaveBeenCalled();
    expect(onLockSkip).toHaveBeenCalledWith(1);
    expect(clock.sleeps).toContain(1_000);
  });

  it('still reports a non-lock failure through onError', async () => {
    const clock = fakeClock();
    const run = vi.fn<() => Promise<RefreshSummary>>().mockRejectedValue(new Error('boom'));
    const onError = vi.fn();
    const scheduler = new RefreshScheduler(run, { ...clock, minIntervalMs: 0, onError });

    scheduler.trigger();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    await scheduler.close();

    expect(scheduler.status().consecutiveErrors).toBe(1);
  });

  it('leaves the idle gap after a pass that outlasts the interval', async () => {
    const clock = fakeClock();
    const run = vi.fn(async () => {
      clock.advance(40_000);
      if (run.mock.calls.length === 1) scheduler.trigger();
      return summary;
    });
    const scheduler = new RefreshScheduler(run, { ...clock, minIntervalMs: 15_000 });

    scheduler.trigger();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));

    expect(clock.sleeps).toEqual([15_000]);
  });

  it('close() resolves promptly while a window wait is sleeping', async () => {
    const run = vi.fn(async () => summary);
    const scheduler = new RefreshScheduler(run, { minIntervalMs: 60_000 });

    scheduler.trigger();
    scheduler.trigger();
    await settle();
    const closed = await Promise.race([
      scheduler.close().then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('stuck'), 1_000)),
    ]);

    expect(closed).toBe('closed');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('forgets lock skips and restarts the backoff after a successful pass', async () => {
    const clock = fakeClock();
    const locked = Object.assign(new Error('held'), { code: 'ELOCKED' });
    const run = vi
      .fn<() => Promise<RefreshSummary>>()
      .mockRejectedValueOnce(locked)
      .mockRejectedValueOnce(locked)
      .mockResolvedValueOnce(summary)
      .mockRejectedValueOnce(locked)
      .mockResolvedValue(summary);
    const scheduler = new RefreshScheduler(run, { ...clock, minIntervalMs: 0 });

    scheduler.trigger();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    await settle();
    expect(scheduler.status().lockSkips).toBe(0);
    scheduler.trigger();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(5));

    expect(clock.sleeps).toEqual([1_000, 2_000, 1_000]);
  });

  describe('runNow', () => {
    it('starts a delta pass inside the min-interval window and resolves fresh', async () => {
      const run = vi.fn(async (_kind: string) => summary);
      const scheduler = new RefreshScheduler(run, { minIntervalMs: 60_000 });
      scheduler.trigger();
      await vi.waitFor(() => expect(scheduler.status().running).toBe(false));

      const freshness = await scheduler.runNow(500);

      expect(freshness).toBe('fresh');
      expect(run.mock.calls.map(([kind]) => kind)).toEqual(['full', 'delta']);
      await scheduler.close();
    });

    it('resolves stale at the budget while a pass outlasts it', async () => {
      let finish: () => void = () => {};
      const run = vi.fn(
        () => new Promise<RefreshSummary>((resolve) => (finish = () => resolve(summary))),
      );
      const scheduler = new RefreshScheduler(run);
      scheduler.trigger();
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let freshness: string | undefined;
      try {
        void scheduler.runNow(50).then((read) => (freshness = read));
        await vi.advanceTimersByTimeAsync(49);
        expect(freshness).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
      } finally {
        vi.useRealTimers();
      }

      expect(freshness).toBe('stale');
      expect(run).toHaveBeenCalledTimes(1);
      finish();
      await scheduler.close();
    });

    it('reads a delta pass that meets the lock held as stale, without queueing a full pass', async () => {
      const locked = Object.assign(new Error('held'), { code: 'ELOCKED' });
      const run = vi.fn(async (kind: string) => {
        if (kind === 'delta') throw locked;
        return summary;
      });
      const onLockSkip = vi.fn();
      const scheduler = new RefreshScheduler(run, { onLockSkip });

      const freshness = await scheduler.runNow(500);

      expect(freshness).toBe('stale');
      expect(onLockSkip).not.toHaveBeenCalled();
      expect(scheduler.status()).toMatchObject({ pending: false, lockSkips: 0 });
    });

    it('after two failed delta passes, a reader inside the backoff starts no pass and reads stale', async () => {
      const clock = fakeClock();
      const run = vi.fn(async (_kind: string) => {
        throw new Error('corrupt');
      });
      const scheduler = new RefreshScheduler(run, { ...clock, onError: () => {} });

      expect(await scheduler.runNow(500)).toBe('stale');
      clock.advance(1_000);
      expect(await scheduler.runNow(500)).toBe('stale');
      expect(run).toHaveBeenCalledTimes(2);

      clock.advance(1_999);
      expect(await scheduler.runNow(500)).toBe('stale');
      expect(run).toHaveBeenCalledTimes(2);

      clock.advance(1);
      await scheduler.runNow(500);
      expect(run).toHaveBeenCalledTimes(3);
    });

    it('a delta success clears the delta backoff', async () => {
      const clock = fakeClock();
      const run = vi
        .fn<(kind: string) => Promise<RefreshSummary>>()
        .mockRejectedValueOnce(new Error('corrupt'))
        .mockResolvedValueOnce(summary)
        .mockRejectedValueOnce(new Error('corrupt'))
        .mockResolvedValue(summary);
      const scheduler = new RefreshScheduler(run, { ...clock, onError: () => {} });

      await scheduler.runNow(500);
      clock.advance(1_000);
      expect(await scheduler.runNow(500)).toBe('fresh');
      expect(await scheduler.runNow(500)).toBe('stale');
      expect(run).toHaveBeenCalledTimes(3);

      clock.advance(1_000);
      expect(await scheduler.runNow(500)).toBe('fresh');
      expect(run).toHaveBeenCalledTimes(4);
    });

    /** A run whose first pass marks itself indexed, then holds until `finish`. */
    function indexedThenHeld() {
      let finish: () => void = () => {};
      const run = vi.fn(async (_kind: string, onIndexed: () => void) => {
        if (run.mock.calls.length > 1) return summary;
        onIndexed();
        await new Promise<void>((resolve) => (finish = resolve));
        return summary;
      });
      return { run, finish: () => finish() };
    }

    it('joins a delta past its index step at once when nothing waits undrained', async () => {
      const { run, finish } = indexedThenHeld();
      const scheduler = new RefreshScheduler(run, { hasUndrained: () => false });
      await scheduler.runNow(500);

      const joined = await scheduler.runNow(500);

      expect(joined).toBe('fresh');
      expect(run).toHaveBeenCalledTimes(1);
      finish();
      await scheduler.close();
    });

    it('follows a delta past its index step with another delta when changes wait undrained', async () => {
      const { run, finish } = indexedThenHeld();
      const scheduler = new RefreshScheduler(run, { hasUndrained: () => true });
      await scheduler.runNow(500);

      const joining = scheduler.runNow(500);
      await settle();
      const kindsWhileHeld = run.mock.calls.map(([kind]) => kind);
      finish();

      expect(await joining).toBe('fresh');
      expect(kindsWhileHeld).toEqual(['delta']);
      expect(run.mock.calls.map(([kind]) => kind)).toEqual(['delta', 'delta']);
      await scheduler.close();
    });

    it('reads stale and starts no follow-up when the joined delta outlasts the budget', async () => {
      const { run, finish } = indexedThenHeld();
      const scheduler = new RefreshScheduler(run, { hasUndrained: () => true });
      await scheduler.runNow(500);

      const joined = await scheduler.runNow(30);
      finish();
      await scheduler.close();

      expect(joined).toBe('stale');
      expect(run).toHaveBeenCalledTimes(1);
    });
  });
});
