import { nowIso } from "@titan-design/store-sqlite";
import type { ContextDeps, RecoveredStep } from "./context-deps.js";
import { isRecoverable } from "./recovery.js";
import { workflowStepRequestKey, type ActiveStep, type StepUsage } from "./types.js";

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

/** The intent a try persists before it starts: recoverable when the runner can reconcile it after a restart. */
export function newActiveStep(
  deps: Pick<ContextDeps, "runner" | "executionId">,
  runId: string,
  stepId: string,
  iterKey: string,
  timing: TryTiming,
  priorUsage: StepUsage | undefined,
): ActiveStep {
  const base = { stepId, iterKey, ...timing, ...(priorUsage ? { priorUsage } : {}) };
  if (!isRecoverable(deps.runner)) return { kind: "legacy", ...base };
  const iteration = Number(iterKey.slice(iterKey.lastIndexOf(":") + 1));
  return { kind: "recoverable", ...base, executionId: deps.executionId(), requestKey: workflowStepRequestKey(runId, stepId, iteration, timing.attempt) };
}
