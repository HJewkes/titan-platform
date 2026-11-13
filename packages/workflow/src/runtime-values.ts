import { CapabilityVault, type WorkflowCapability } from "./capabilities.js";
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

export function vaultOf(capabilities: Readonly<Record<string, WorkflowCapability>> | undefined): CapabilityVault | undefined {
  return capabilities && new CapabilityVault(capabilities);
}

/** The class a rejection carries as its own `errorClass` field, so a host sets it where it fails rather than in the text. */
export function errorClassOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("errorClass" in error)) return undefined;
  return typeof error.errorClass === "string" && error.errorClass !== "" ? error.errorClass : undefined;
}

/** The text a failed run records: secrets of the runtime's capabilities redacted. */
export function failureText(error: unknown, vault: CapabilityVault | undefined): string {
  return vault ? vault.redact(messageOf(error)) : messageOf(error);
}
