import { DEFAULT_SPAWN_LIMITS, type MachineReadings, type SpawnLimits } from "./spawn-gate.js";
import { DEFAULT_HOLD_WAIT_MS, type PollTiming } from "./review-wait.js";

type StopLimits = Pick<SpawnLimits, "load5" | "pressureLevel" | "freeMemoryPct">;

/** Pure: the machine-stop breach these readings show, worded for a log line, or undefined when clear; an unread reading never stops. */
export function stopReason(readings: MachineReadings, limits: StopLimits = DEFAULT_SPAWN_LIMITS): string | undefined {
  if (readings.load5 > limits.load5) return `load5 ${readings.load5} (limit ${limits.load5})`;
  if (readings.pressureLevel !== undefined && readings.pressureLevel >= limits.pressureLevel) return `memory pressure level ${readings.pressureLevel} (limit ${limits.pressureLevel})`;
  if (readings.freeMemoryPct !== undefined && readings.freeMemoryPct < limits.freeMemoryPct) return `free memory ${readings.freeMemoryPct}% (limit ${limits.freeMemoryPct}%)`;
  return undefined;
}

/**
 * The stops this process has seen, so a step that ends later can ask whether one applied while it ran. It is fed by whoever
 * reads the machine (the spawn gate, the broker's machine_hold refusal) and lives in memory: a restart forgets it, and a stop
 * still in effect after the restart is caught by the next `sample`.
 */
export interface MachineStopWatch {
  /** Records a stop seen at `at` (epoch ms). */
  note(at: number, reason: string): void;
  /** Reads the machine now, notes a stop if there is one, and returns its reason. */
  sample(): string | undefined;
  /** The newest stop noted at or after `from`, or undefined when none was. */
  stoppedSince(from: number): string | undefined;
}

interface MachineStopWatchOptions {
  read: () => MachineReadings;
  limits?: Partial<StopLimits>;
  now?: () => number;
}

interface NotedStop {
  at: number;
  reason: string;
}

const MINUTE_MS = 60_000;

/** Keeps the newest stop per minute, so a storm of spawn refusals stays small, and forgets stops older than the hold ceiling. */
export function machineStopWatch({ read, limits, now = Date.now }: MachineStopWatchOptions): MachineStopWatch {
  const stopLimits = { ...DEFAULT_SPAWN_LIMITS, ...limits };
  const stops = new Map<number, NotedStop>();
  const note = (at: number, reason: string) => {
    const minute = Math.floor(at / MINUTE_MS);
    if ((stops.get(minute)?.at ?? -Infinity) <= at) stops.set(minute, { at, reason });
    for (const [key, stop] of stops) if (stop.at < at - DEFAULT_HOLD_WAIT_MS) stops.delete(key);
  };
  return {
    note,
    sample() {
      const reason = stopReason(read(), stopLimits);
      if (reason !== undefined) note(now(), reason);
      return reason;
    },
    stoppedSince(from) {
      const newest = [...stops.values()].filter((stop) => stop.at >= from).sort((a, b) => b.at - a.at)[0];
      return newest?.reason;
    },
  };
}

export type Lift = { lifted: true } | { lifted: false; reason: string };

/** Samples the machine every `pollMs` until the stop clears, or answers `lifted: false` with the last reason once `ceilingMs` has passed. */
export async function awaitLift(watch: MachineStopWatch, timing: PollTiming, signal: AbortSignal, ceilingMs: number = DEFAULT_HOLD_WAIT_MS): Promise<Lift> {
  const start = timing.now();
  for (;;) {
    signal.throwIfAborted();
    const reason = watch.sample();
    if (reason === undefined) return { lifted: true };
    const left = ceilingMs - (timing.now() - start);
    if (left <= 0) return { lifted: false, reason };
    await timing.sleep(Math.min(timing.pollMs, left), signal);
  }
}
