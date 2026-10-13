import type { RoutedStepInput } from "@titan-design/workflow";

export const DEFAULT_JUMP_SLACK_MS = 60_000;
export const DEFAULT_JUMP_GRACE_MS = 2 * 60_000;

export interface DeadlineTiming {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  timeoutMs: number;
  /** When the wait first began, in epoch ms; a restart resumes from it, so a re-dispatched wait gets only what is left. Absent, or ahead of `now`, means now. */
  startedAt?: number | undefined;
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
  if (!Number.isFinite(timing.timeoutMs)) throw new RangeError(`deadline needs a finite timeoutMs, got ${timing.timeoutMs}`);
  const slack = timing.jumpSlackMs ?? DEFAULT_JUMP_SLACK_MS;
  const grace = timing.jumpGraceMs ?? DEFAULT_JUMP_GRACE_MS;
  const end = Math.min(timing.startedAt ?? Number.POSITIVE_INFINITY, timing.now()) + timing.timeoutMs;
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

/** When a step first started and how many restarts re-ran it; the start is absent for a dispatch that does not carry one. */
export interface StepClock {
  firstStartedAtMs: number | undefined;
  restarts: number;
}

export function stepClock(step: Pick<RoutedStepInput, "firstStartedAt" | "restarts">): StepClock {
  const firstStartedAtMs = step.firstStartedAt === undefined ? undefined : Date.parse(step.firstStartedAt);
  return { firstStartedAtMs: Number.isFinite(firstStartedAtMs) ? firstStartedAtMs : undefined, restarts: step.restarts ?? 0 };
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => (signal.removeEventListener("abort", abort), resolve()), ms);
    const abort = () => (clearTimeout(timer), reject(signal.reason));
    signal.addEventListener("abort", abort, { once: true });
  });
}
