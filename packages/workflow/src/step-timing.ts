import { nowIso } from "@titan-design/store-sqlite";
import type { RecoveredStep } from "./context-deps.js";
import type { ActiveStep } from "./types.js";

export interface TryTiming {
  attempt: number;
  restarts: number;
  startedAt: string;
  firstStartedAt: string;
}

/** A retry-safe recovery re-dispatches a step a restart cut off; it raises both counts, so it spends no retry budget. */
export function resumeCounts(recovered: RecoveredStep | undefined): { attempt: number; restarts: number } {
  const restarted = recovered?.kind === "retry_safe" ? 1 : 0;
  return { attempt: (recovered?.step.attempt ?? 0) + restarted, restarts: (recovered?.step.restarts ?? 0) + restarted };
}

/** A new try keeps the first start of `previous`, the try it replaces; a step's first try stamps it. */
export function tryTiming(attempt: number, restarts: number, previous: ActiveStep | undefined): TryTiming {
  const startedAt = nowIso();
  return { attempt, restarts, startedAt, firstStartedAt: previous?.firstStartedAt ?? previous?.startedAt ?? startedAt };
}

/** Rows stored before restart counting read as first started at `startedAt` and never restarted. */
export function dispatchTiming(step: ActiveStep): { firstStartedAt: string; restarts: number } {
  return { firstStartedAt: step.firstStartedAt ?? step.startedAt, restarts: step.restarts ?? 0 };
}
