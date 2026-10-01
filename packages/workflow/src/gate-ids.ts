import type { GateStore } from "@titan-design/hitl";
import type { StepOperation, WorkflowRun } from "./types.js";

export function gateIdFor(runId: string, stepId: string): string {
  return `${runId}/${stepId}`;
}

/** Where call `index` of `stepId` records its result: the keys earlier releases wrote, so one call position never has two homes. */
export function memoKey(operation: StepOperation, stepId: string, index: number): string {
  return index === 0 && operation !== "dispatch" ? stepId : `${stepId}:${index}`;
}

/**
 * A run paused by 0.2.x inside `assisted(x)` after a `dispatch(x)` has its answer waiting
 * on the bare gate, so adopt that gate instead of orphaning it and asking the human twice.
 */
export function assistedGateId(run: WorkflowRun, stepId: string, iteration: number, isPending: GatePredicate): string {
  const legacy = gateIdFor(run.id, stepId);
  if (iteration === 0) return legacy;
  if (!run.stepResults[stepId] && isPending(legacy)) return legacy;
  return gateIdFor(run.id, memoKey("assisted", stepId, iteration));
}

/** Every recorded result for `stepId` is one earlier call, so the count is the iteration of the gate now waiting. */
export function pendingGateId(run: WorkflowRun, stepId: string, isPending: GatePredicate): string {
  const repeat = `${stepId}:`;
  const calls = Object.keys(run.stepResults).filter(
    (key) => key === stepId || (key.startsWith(repeat) && /^\d+$/.test(key.slice(repeat.length))),
  ).length;
  return assistedGateId(run, stepId, calls, isPending);
}

export type GatePredicate = (gateId: string) => boolean;

export function gateIsPending(gates: GateStore, gateId: string): boolean {
  return gates.get(gateId)?.status === "pending";
}
