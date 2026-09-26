import type { ExecutionOwnerFence, ExecutionOwnerLease, ExecutionRecord } from "./lifecycle.js";
import { fail, instant, validTime, validateFence, validateLease } from "./lifecycle-validation.js";

/**
 * `execution` fences each row by its own owner lease. `supervisor` fences by one supervisor-wide lease
 * that the ledger reads inside its atomic operation, so a restarted supervisor adopts rows without per-row events.
 */
export type ExecutionFencing = { kind: "execution" } | { kind: "supervisor"; lease: ExecutionOwnerLease };

export interface ExecutionReducerOptions {
  fencing?: ExecutionFencing;
}

const EXECUTION_FENCING: ExecutionFencing = { kind: "execution" };

export function resolveFencing(options: ExecutionReducerOptions): ExecutionFencing {
  const fencing = options.fencing ?? EXECUTION_FENCING;
  if (fencing.kind === "supervisor") {
    validateFence(fencing.lease);
    validTime("fencing.lease.leaseUntil", fencing.lease.leaseUntil);
  } else if (fencing.kind !== "execution") {
    fail("invalid_transition", "fencing.kind must be execution or supervisor");
  }
  return fencing;
}

export function requireFence<TResult>(
  current: ExecutionRecord<TResult>,
  fence: ExecutionOwnerFence,
  occurredAt: string,
  fencing: ExecutionFencing,
): void {
  validateFence(fence);
  if (fencing.kind === "supervisor") return requireSupervisorFence(current, fence, occurredAt, fencing.lease);
  const owner = current.owner;
  if (!owner || owner.supervisorId !== fence.supervisorId || owner.generation !== fence.generation) {
    fail("ownership_lost", "execution owner fence does not match");
  }
  if (instant(owner.leaseUntil) <= instant(occurredAt)) fail("ownership_lost", "execution owner lease has expired");
}

function requireSupervisorFence<TResult>(
  current: ExecutionRecord<TResult>,
  fence: ExecutionOwnerFence,
  occurredAt: string,
  lease: ExecutionOwnerLease,
): void {
  if (fence.supervisorId !== lease.supervisorId || fence.generation !== lease.generation) {
    fail("ownership_lost", "fence does not match the supervisor lease");
  }
  if (instant(lease.leaseUntil) <= instant(occurredAt)) fail("ownership_lost", "supervisor lease has expired");
  if (current.owner?.supervisorId !== fence.supervisorId) fail("ownership_lost", "execution belongs to another supervisor");
  if (current.ownerGeneration > lease.generation) fail("ownership_lost", "execution was written by a newer supervisor generation");
}

export function requirePreparedOwner(owner: ExecutionOwnerLease, occurredAt: string, fencing: ExecutionFencing): void {
  validateLease(owner, occurredAt);
  if (fencing.kind === "execution") {
    if (owner.generation !== 1) fail("invalid_transition", "initial owner generation must be 1");
    return;
  }
  const { lease } = fencing;
  if (owner.supervisorId !== lease.supervisorId || owner.generation !== lease.generation || owner.leaseUntil !== lease.leaseUntil) {
    fail("ownership_lost", "prepare owner must equal the supervisor lease");
  }
}

/** Per-row lease events would race the supervisor row, which is the only lease in supervisor mode. */
export function refuseOwnerTransition(kind: string, fencing: ExecutionFencing): void {
  const ownerTransition = kind === "claim_owner" || kind === "renew_owner" || kind === "release_owner";
  if (ownerTransition && fencing.kind === "supervisor") fail("invalid_transition", `${kind} is not allowed under supervisor fencing`);
}

/** Every accepted supervisor-mode write adopts the row into the current lease. */
export function stampSupervisor<TResult>(record: ExecutionRecord<TResult>, fencing: ExecutionFencing): ExecutionRecord<TResult> {
  if (fencing.kind !== "supervisor") return record;
  return { ...record, ownerGeneration: fencing.lease.generation, ...(record.owner ? { owner: { ...fencing.lease } } : {}) };
}
