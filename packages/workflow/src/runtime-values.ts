import { WorkflowOwnershipLostError } from "./store.js";
import type { WorkflowOwnerFence, WorkflowRun } from "./types.js";

export class RuntimeShutdown extends Error {
  constructor() {
    super("runtime shutting down");
    this.name = "RuntimeShutdown";
  }
}

export class WorkflowPersistenceError extends Error {
  constructor(runId: string, cause: unknown) {
    super(`workflow ${runId} persistence failed: ${messageOf(cause)}`, { cause });
    this.name = "WorkflowPersistenceError";
  }
}

export function positiveDuration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

export function timestampAt(value: number, name: string): string {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must return a safe integer timestamp`);
  try {
    return new Date(value).toISOString();
  } catch {
    throw new TypeError(`${name} must return a valid timestamp`);
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function fenceOf(run: WorkflowRun): WorkflowOwnerFence {
  if (!run.owner) throw new WorkflowOwnershipLostError(run.id);
  return { runtimeId: run.owner.runtimeId, generation: run.owner.generation };
}

export function sameFence(owner: WorkflowOwnerFence, expected: WorkflowOwnerFence): boolean {
  return owner.runtimeId === expected.runtimeId && owner.generation === expected.generation;
}
