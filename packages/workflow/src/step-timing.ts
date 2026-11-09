import { nowIso } from "@titan-design/store-sqlite";
import type { ContextDeps, RecoveredStep } from "./context-deps.js";
import { isRecoverable } from "./recovery.js";
import { addUsage } from "./usage.js";
import { workflowStepRequestKey, type ActiveStep, type StepUsage } from "./types.js";

interface TryTiming {
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

/**
 * The spend a resumed step carries in from its earlier tries. A try reconcile settles reports its own full spend, so
 * its unsettled report is left out; a retry-safe restart replaces the try, so that report is charged here, once.
 */
export function resumedUsage(recovered: RecoveredStep | undefined): StepUsage | undefined {
  return recovered?.kind === "retry_safe" ? everyTrySpend(recovered.step).usage : recovered?.step.priorUsage;
}

/** What every try of an active step spent, its unsettled one included, for a step that ends without another report. */
export function everyTrySpend(step: ActiveStep): { usage?: StepUsage } {
  const usage = addUsage(step.priorUsage, step.unsettledUsage);
  return usage ? { usage } : {};
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

/** The timing a completed try carries onto its result, so the run keeps its start times and restarts once the step is done. */
export function completedTiming(step: ActiveStep): { startedAt: string; firstStartedAt: string; restarts: number } {
  return { startedAt: step.startedAt, ...dispatchTiming(step) };
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
