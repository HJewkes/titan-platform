import type { ConversationIdentity, ExecutionIdentity, SurfaceIdentity } from "./index.js";
import type { ExecutionOwnerFence, ExecutionOwnerLease, ExecutionTerminal, LifecycleExecutionTarget } from "./lifecycle.js";

export type ExecutionTransitionErrorCode =
  | "not_found"
  | "revision_conflict"
  | "invalid_transition"
  | "ownership_lost";

export class ExecutionTransitionError extends Error {
  constructor(
    readonly code: ExecutionTransitionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExecutionTransitionError";
  }
}

export function validateConversation(conversation: ConversationIdentity, harness: string): void {
  if (!record(conversation)) fail("invalid_transition", "conversation must be an object");
  nonempty("conversation.harness", conversation.harness);
  nonempty("conversation.namespace", conversation.namespace);
  nonempty("conversation.nativeId", conversation.nativeId);
  if (conversation.harness !== harness) fail("invalid_transition", "conversation harness does not match execution harness");
}

export function validateTerminal(terminal: ExecutionTerminal<unknown>): void {
  const outcomes = ["succeeded", "failed", "cancelled", "cancellation_unknown"];
  if (!record(terminal) || !outcomes.includes(terminal.outcome as string)) fail("invalid_transition", "terminal.outcome is invalid");
  if (terminal.outcome === "succeeded") {
    if (!("result" in terminal) || terminal.result === undefined) fail("invalid_transition", "succeeded terminal must carry a result");
    return;
  }
  nonempty("terminal.reason", terminal.reason);
  if (terminal.outcome === "failed" && typeof terminal.retryable !== "boolean") {
    fail("invalid_transition", "terminal.retryable must be boolean");
  }
  if (terminal.outcome === "cancellation_unknown") nonempty("terminal.evidence", terminal.evidence);
}

export function validateLease(lease: ExecutionOwnerLease, occurredAt: string): void {
  if (!record(lease)) fail("invalid_transition", "owner lease must be an object");
  validateFence(lease);
  validTime("owner.leaseUntil", lease.leaseUntil);
  if (instant(lease.leaseUntil) <= instant(occurredAt)) fail("ownership_lost", "owner lease must extend beyond occurredAt");
}

export function validateFence(fence: ExecutionOwnerFence): void {
  if (!record(fence)) fail("invalid_transition", "owner fence must be an object");
  nonempty("owner.supervisorId", fence.supervisorId);
  positiveInteger("owner.generation", fence.generation);
}

export function sameConversation(left: ConversationIdentity, right: ConversationIdentity): boolean {
  return left.harness === right.harness && left.namespace === right.namespace && left.nativeId === right.nativeId;
}

export function sameSurface(left: SurfaceIdentity, right: SurfaceIdentity): boolean {
  return left.kind === right.kind && left.host === right.host && left.nativeId === right.nativeId && left.owned === right.owned;
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cloneExecution(execution: ExecutionIdentity): ExecutionIdentity {
  return { ...execution, ...(execution.conversation ? { conversation: { ...execution.conversation } } : {}) };
}

export function cloneTarget(target: LifecycleExecutionTarget): LifecycleExecutionTarget {
  return target.kind === "fresh" ? { ...target } : { kind: "resume", conversation: { ...target.conversation } };
}

export function nonempty(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) fail("invalid_transition", `${name} must be a nonempty string`);
}

export function optionalNonempty(name: string, value: unknown): void {
  if (value !== undefined) nonempty(name, value);
}

export function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) fail("invalid_transition", `${name} must be a positive safe integer`);
}

export function nonnegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid_transition", `${name} must be a nonnegative safe integer`);
}

export function validTime(name: string, value: string): void {
  nonempty(name, value);
  if (!Number.isFinite(Date.parse(value))) fail("invalid_transition", `${name} must be a parseable timestamp`);
}

export function instant(value: string): number { return Date.parse(value); }

export function fail(code: ExecutionTransitionErrorCode, message: string): never {
  throw new ExecutionTransitionError(code, message);
}
