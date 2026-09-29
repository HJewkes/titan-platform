export const DEFAULT_JUMP_SLACK_MS = 60_000;
export const DEFAULT_JUMP_GRACE_MS = 2 * 60_000;

export interface DeadlineTiming {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  timeoutMs: number;
  /** A sleep that overruns its request by more than this is a clock jump. */
  jumpSlackMs?: number;
  /** After a jump, the one fresh poll comes at least this long after the wake. */
  jumpGraceMs?: number;
}

export interface Deadline {
  /** Sleeps through `timing.sleep`, and notes a clock jump. Once the grace poll is granted, the sleep is at least the grace. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** True once the deadline passed. After a jump it is false once, so the caller polls one more time. */
  expired(): boolean;
}

/** A wall-clock step deadline that a suspended host or a stepped clock cannot spuriously expire. */
export function deadline(timing: DeadlineTiming): Deadline {
  const slack = timing.jumpSlackMs ?? DEFAULT_JUMP_SLACK_MS;
  const grace = timing.jumpGraceMs ?? DEFAULT_JUMP_GRACE_MS;
  const end = timing.now() + timing.timeoutMs;
  let jumped = false;
  let graceGranted = false;
  return {
    async sleep(ms, signal) {
      const before = timing.now();
      await timing.sleep(graceGranted ? Math.max(ms, grace) : ms, signal);
      const after = timing.now();
      if (!graceGranted && after >= end && after - before > ms + slack) jumped = true;
    },
    expired() {
      if (timing.now() < end) return false;
      if (jumped && !graceGranted) {
        graceGranted = true;
        return false;
      }
      return true;
    },
  };
}
