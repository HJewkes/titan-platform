import type { ConversationIdentity, ExecutionIdentity, SurfaceIdentity } from "./index.js";
import {
  TERMINAL_EXECUTION_PHASES,
  type ExecutionPhase,
  type ExecutionRecord,
  type ExecutionTransition,
  type TerminalExecutionPhase,
} from "./lifecycle.js";
import { validateCorrelations } from "./lifecycle-correlations.js";
import {
  refuseOwnerTransition,
  requireFence,
  requirePreparedOwner,
  resolveFencing,
  stampSupervisor,
  type ExecutionFencing,
  type ExecutionReducerOptions,
} from "./lifecycle-fencing.js";
import { cloneTarget, preparedExecution, requireTargetConversation } from "./lifecycle-targets.js";
import {
  fail,
  instant,
  nonempty,
  nonnegativeInteger,
  optionalNonempty,
  record,
  sameConversation,
  sameSurface,
  validTime,
  validateConversation,
  validateLease,
  validateTerminal,
} from "./lifecycle-validation.js";

const TERMINAL_PHASES = new Set<ExecutionPhase>(TERMINAL_EXECUTION_PHASES);

export function isTerminalExecutionPhase(phase: ExecutionPhase): phase is TerminalExecutionPhase {
  return TERMINAL_PHASES.has(phase);
}

/** The default fencing mode is the per-execution owner lease. */
export function reduceExecutionTransition<TResult>(
  current: ExecutionRecord<TResult> | undefined,
  transition: ExecutionTransition<TResult>,
  options: ExecutionReducerOptions = {},
): ExecutionRecord<TResult> {
  const fencing = resolveFencing(options);
  validateEnvelope(transition);
  if (transition.kind === "prepare") return prepare(current, transition, fencing);
  if (!current) fail("not_found", `execution ${transition.executionId} does not exist`);
  validateCurrent(current, transition);
  if (isTerminalExecutionPhase(current.phase)) fail("invalid_transition", `execution is terminal in phase ${current.phase}`);
  refuseOwnerTransition(transition.kind, fencing);
  if (transition.kind === "claim_owner") return claimOwner(current, transition);
  requireFence(current, transition.fence, transition.occurredAt, fencing);
  return stampSupervisor(applyFenced(current, transition), fencing);
}

function applyFenced<TResult>(
  current: ExecutionRecord<TResult>,
  transition: Exclude<ExecutionTransition<TResult>, { kind: "prepare" | "claim_owner" }>,
): ExecutionRecord<TResult> {
  switch (transition.kind) {
    case "begin_dispatch":
      requirePhase(current, ["prepared"], transition.kind);
      return next(current, transition, { phase: "dispatching", dispatchedAt: transition.occurredAt });
    case "observe_launched":
      return observeLaunched(current, transition);
    case "observe_running":
      return observeRunning(current, transition);
    case "identify_conversation":
      return identifyConversation(current, transition);
    case "request_cancellation":
      return requestCancellation(current, transition);
    case "require_recovery":
      return requireRecovery(current, transition);
    case "finish":
      return finish(current, transition);
    case "renew_owner":
      return renewOwner(current, transition);
    case "release_owner":
      return next(current, transition, { owner: undefined });
    default:
      return fail("invalid_transition", "unknown execution transition kind");
  }
}

function prepare<TResult>(
  current: ExecutionRecord<TResult> | undefined,
  transition: Extract<ExecutionTransition<TResult>, { kind: "prepare" }>,
  fencing: ExecutionFencing,
): ExecutionRecord<TResult> {
  if (current) fail("invalid_transition", `execution ${transition.executionId} already exists`);
  const execution = preparedExecution(transition);
  if (transition.execution.executionId !== transition.executionId) {
    fail("invalid_transition", "prepared executionId does not match transition executionId");
  }
  optionalNonempty("agent.agentId", transition.agent?.agentId);
  nonempty("requestKey", transition.requestKey);
  requirePreparedOwner(transition.owner, transition.occurredAt, fencing);
  return {
    execution,
    ...(transition.agent ? { agent: { ...transition.agent } } : {}),
    harness: transition.harness,
    requestKey: transition.requestKey,
    target: cloneTarget(transition.target),
    phase: "prepared",
    revision: 1,
    ownerGeneration: transition.owner.generation,
    owner: { ...transition.owner },
    preparedAt: transition.occurredAt,
    lastObservedAt: transition.occurredAt,
    ...(transition.correlations === undefined ? {} : { correlations: validateCorrelations(transition.correlations) }),
  };
}

function observeRunning<TResult>(
  current: ExecutionRecord<TResult>,
  transition: Extract<ExecutionTransition<TResult>, { kind: "observe_running" }>,
): ExecutionRecord<TResult> {
  requirePhase(current, ["dispatching", "recovery_required"], transition.kind);
  nonempty("runnerRef", transition.runnerRef);
  nonempty("evidence", transition.evidence);
  if (current.runnerRef && current.runnerRef !== transition.runnerRef) fail("invalid_transition", "runnerRef cannot change");
  const conversation = transition.conversation ?? transition.adapterExecution.conversation;
  const execution = bindConversation(current, conversation);
  const adapterExecution = bindAdapterExecution(current, transition.adapterExecution, conversation);
  const surface = bindSurface(current.surface, transition.surface);
  return next(current, transition, {
    execution,
    phase: "running",
    runnerRef: transition.runnerRef,
    adapterExecution,
    ...(surface ? { surface } : {}),
    recovery: undefined,
  });
}

/** Records a surface before the harness confirms running; the phase deliberately stays put. */
function observeLaunched<TResult>(
  current: ExecutionRecord<TResult>,
  transition: Extract<ExecutionTransition<TResult>, { kind: "observe_launched" }>,
): ExecutionRecord<TResult> {
  requirePhase(current, ["dispatching"], transition.kind);
  nonempty("runnerRef", transition.runnerRef);
  nonempty("evidence", transition.evidence);
  if (current.runnerRef && current.runnerRef !== transition.runnerRef) fail("invalid_transition", "runnerRef cannot change");
  if (!transition.surface) fail("invalid_transition", "observe_launched must carry a surface");
  const surface = bindSurface(current.surface, transition.surface);
  return next(current, transition, { runnerRef: transition.runnerRef, ...(surface ? { surface } : {}) });
}

function identifyConversation<TResult>(
  current: ExecutionRecord<TResult>,
  transition: Extract<ExecutionTransition<TResult>, { kind: "identify_conversation" }>,
): ExecutionRecord<TResult> {
  requirePhase(current, ["dispatching", "running", "cancel_requested", "recovery_required"], transition.kind);
  const execution = bindConversation(current, transition.conversation);
  const adapterExecution = current.adapterExecution
    ? bindAdapterExecution(current, { ...current.adapterExecution, conversation: transition.conversation }, transition.conversation)
    : undefined;
  return next(current, transition, { execution, ...(adapterExecution ? { adapterExecution } : {}) });
}

function requestCancellation<TResult>(
  current: ExecutionRecord<TResult>,
  transition: Extract<ExecutionTransition<TResult>, { kind: "request_cancellation" }>,
): ExecutionRecord<TResult> {
  requirePhase(current, ["prepared", "dispatching", "running", "recovery_required"], transition.kind);
  nonempty("reason", transition.reason);
  return next(current, transition, {
    phase: "cancel_requested",
    cancellation: { requestedAt: transition.occurredAt, reason: transition.reason },
  });
}

function requireRecovery<TResult>(
  current: ExecutionRecord<TResult>,
  transition: Extract<ExecutionTransition<TResult>, { kind: "require_recovery" }>,
): ExecutionRecord<TResult> {
  requirePhase(current, ["dispatching", "running", "cancel_requested"], transition.kind);
  nonempty("evidence", transition.evidence);
  return next(current, transition, {
    phase: "recovery_required",
    recovery: { requiredAt: transition.occurredAt, evidence: transition.evidence },
  });
}

function finish<TResult>(
  current: ExecutionRecord<TResult>,
  transition: Extract<ExecutionTransition<TResult>, { kind: "finish" }>,
): ExecutionRecord<TResult> {
  validateTerminal(transition.terminal);
  if (current.phase === "prepared" && !["failed", "cancelled"].includes(transition.terminal.outcome)) {
    fail("invalid_transition", `prepared execution cannot finish as ${transition.terminal.outcome}`);
  }
  const conversation = transition.conversation ?? transition.adapterExecution?.conversation;
  const execution = bindConversation(current, conversation);
  const adapterExecution = transition.adapterExecution
    ? bindAdapterExecution(current, transition.adapterExecution, conversation)
    : current.adapterExecution;
  return next(current, transition, {
    execution,
    ...(adapterExecution ? { adapterExecution } : {}),
    phase: transition.terminal.outcome,
    owner: undefined,
    recovery: undefined,
    terminal: transition.terminal,
    finishedAt: transition.occurredAt,
  });
}

function claimOwner<TResult>(
  current: ExecutionRecord<TResult>,
  transition: Extract<ExecutionTransition<TResult>, { kind: "claim_owner" }>,
): ExecutionRecord<TResult> {
  validateLease(transition.owner, transition.occurredAt);
  if (transition.owner.generation !== current.ownerGeneration + 1) {
    fail("ownership_lost", `owner generation must be ${current.ownerGeneration + 1}`);
  }
  if (current.owner && instant(current.owner.leaseUntil) > instant(transition.occurredAt)) {
    fail("ownership_lost", "current owner lease has not expired");
  }
  return next(current, transition, { owner: { ...transition.owner }, ownerGeneration: transition.owner.generation });
}

function renewOwner<TResult>(
  current: ExecutionRecord<TResult>,
  transition: Extract<ExecutionTransition<TResult>, { kind: "renew_owner" }>,
): ExecutionRecord<TResult> {
  validTime("leaseUntil", transition.leaseUntil);
  if (!current.owner || instant(transition.leaseUntil) <= instant(current.owner.leaseUntil)) {
    fail("invalid_transition", "renewed lease must extend the current lease");
  }
  return next(current, transition, { owner: { ...current.owner, leaseUntil: transition.leaseUntil } });
}

function next<TResult>(
  current: ExecutionRecord<TResult>,
  transition: ExecutionTransition<TResult>,
  patch: Partial<ExecutionRecord<TResult>>,
): ExecutionRecord<TResult> {
  return { ...current, ...patch, revision: current.revision + 1, lastObservedAt: transition.occurredAt };
}

function validateEnvelope(transition: ExecutionTransition<unknown>): void {
  nonempty("executionId", transition.executionId);
  nonempty("eventId", transition.eventId);
  nonnegativeInteger("expectedRevision", transition.expectedRevision);
  validTime("occurredAt", transition.occurredAt);
  if (transition.kind === "prepare" && transition.expectedRevision !== 0) {
    fail("revision_conflict", "prepare expects absent revision 0");
  }
}

function validateCurrent<TResult>(current: ExecutionRecord<TResult>, transition: ExecutionTransition<TResult>): void {
  if (current.execution.executionId !== transition.executionId) fail("invalid_transition", "transition executionId does not match record");
  if (current.revision !== transition.expectedRevision) {
    fail("revision_conflict", `expected revision ${transition.expectedRevision}, found ${current.revision}`);
  }
  if (instant(transition.occurredAt) < instant(current.lastObservedAt)) {
    fail("invalid_transition", "occurredAt precedes the latest observation");
  }
}

function requirePhase<TResult>(current: ExecutionRecord<TResult>, allowed: ExecutionPhase[], event: string): void {
  if (!allowed.includes(current.phase)) fail("invalid_transition", `${event} is not allowed from ${current.phase}`);
}

function bindConversation<TResult>(current: ExecutionRecord<TResult>, conversation?: ConversationIdentity): ExecutionIdentity {
  if (!conversation) return current.execution;
  validateConversation(conversation, current.harness);
  requireTargetConversation(current.target, conversation, "conversation");
  const observed = current.execution.conversation;
  if (observed && !sameConversation(observed, conversation)) fail("invalid_transition", "conversation identity cannot change");
  return { ...current.execution, conversation: { ...conversation } };
}

function bindAdapterExecution<TResult>(
  current: ExecutionRecord<TResult>,
  observed: ExecutionIdentity,
  conversation?: ConversationIdentity,
): ExecutionIdentity {
  if (!record(observed)) fail("invalid_transition", "adapterExecution must be an object");
  nonempty("adapterExecution.executionId", observed.executionId);
  const existing = current.adapterExecution;
  if (existing && existing.executionId !== observed.executionId) fail("invalid_transition", "adapter execution identity cannot change");
  const identified = conversation ?? observed.conversation ?? existing?.conversation;
  if (identified) {
    validateConversation(identified, current.harness);
    requireTargetConversation(current.target, identified, "adapter conversation");
    for (const candidate of [conversation, observed.conversation, existing?.conversation]) {
      if (candidate && !sameConversation(candidate, identified)) fail("invalid_transition", "adapter conversation identity cannot change");
    }
  }
  return { executionId: observed.executionId, ...(identified ? { conversation: { ...identified } } : {}) };
}

function bindSurface(current: SurfaceIdentity | undefined, observed: SurfaceIdentity | undefined): SurfaceIdentity | undefined {
  if (!observed) return current;
  if (!record(observed)) fail("invalid_transition", "surface must be an object");
  nonempty("surface.kind", observed.kind);
  nonempty("surface.host", observed.host);
  nonempty("surface.nativeId", observed.nativeId);
  if (typeof observed.owned !== "boolean") fail("invalid_transition", "surface.owned must be boolean");
  if (current && !sameSurface(current, observed)) fail("invalid_transition", "surface identity cannot change");
  return { ...observed };
}
