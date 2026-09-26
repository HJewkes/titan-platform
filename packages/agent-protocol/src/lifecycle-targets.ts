import type { AgentIdentity, ConversationIdentity, ExecutionIdentity } from "./index.js";
import type { ExecutionTransition, HandoffIdentity, LifecycleExecutionTarget } from "./lifecycle.js";
import {
  cloneExecution,
  fail,
  nonempty,
  nonnegativeInteger,
  optionalNonempty,
  record,
  sameConversation,
  validateConversation,
  validateConversationShape,
} from "./lifecycle-validation.js";

type PrepareTransition = Extract<ExecutionTransition<unknown>, { kind: "prepare" }>;
type Target<K extends LifecycleExecutionTarget["kind"]> = Extract<LifecycleExecutionTarget, { kind: K }>;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Validates the prepared identity against its target and returns the execution to store. */
export function preparedExecution(transition: PrepareTransition): ExecutionIdentity {
  const { execution, harness, target } = transition;
  if (!record(execution)) fail("invalid_transition", "execution must be an object");
  nonempty("execution.executionId", execution.executionId);
  nonempty("harness", harness);
  if (!record(target)) fail("invalid_transition", "target must be an object");
  switch (target.kind) {
    case "fresh":
      return freshExecution(execution, harness, target);
    case "resume":
      return resumeExecution(execution, harness, target);
    case "fork":
      nonempty("target.namespace", target.namespace);
      validateConversation(target.parent, harness);
      return unstartedExecution(execution, target.kind);
    case "handoff":
      validateHandoff(target, transition.agent);
      return unstartedExecution(execution, target.kind);
    default:
      return fail("invalid_transition", "target.kind must be fresh, resume, fork or handoff");
  }
}

function freshExecution(execution: ExecutionIdentity, harness: string, target: Target<"fresh">): ExecutionIdentity {
  nonempty("target.namespace", target.namespace);
  if (target.pinnedNativeId === undefined) return unstartedExecution(execution, target.kind);
  nonempty("target.pinnedNativeId", target.pinnedNativeId);
  const pinned = { harness, namespace: target.namespace, nativeId: target.pinnedNativeId };
  if (execution.conversation && !sameConversation(execution.conversation, pinned)) {
    fail("invalid_transition", "execution conversation does not match the pinned conversation");
  }
  return { ...cloneExecution(execution), conversation: pinned };
}

function resumeExecution(execution: ExecutionIdentity, harness: string, target: Target<"resume">): ExecutionIdentity {
  validateConversation(target.conversation, harness);
  if (!execution.conversation || !sameConversation(execution.conversation, target.conversation)) {
    fail("invalid_transition", "resume execution must carry its target conversation");
  }
  return cloneExecution(execution);
}

function unstartedExecution(execution: ExecutionIdentity, kind: string): ExecutionIdentity {
  if (execution.conversation) fail("invalid_transition", `${kind} execution cannot begin with a conversation`);
  return cloneExecution(execution);
}

function validateHandoff(target: Target<"handoff">, agent: AgentIdentity | undefined): void {
  nonempty("target.namespace", target.namespace);
  const handoff = target.handoff;
  if (!record(handoff)) fail("invalid_transition", "target.handoff must be an object");
  nonempty("handoff.handoffId", handoff.handoffId);
  nonempty("handoff.lineageId", handoff.lineageId);
  if (!Number.isSafeInteger(handoff.generation) || handoff.generation < 2) {
    fail("invalid_transition", "handoff.generation must be an integer of at least 2");
  }
  validatePredecessor(handoff.predecessor);
  validateBrief(handoff.brief);
  if (!record(agent)) fail("invalid_transition", "handoff execution must name its agent");
  nonempty("agent.agentId", agent.agentId);
  if (agent.agentId === handoff.predecessor.agent.agentId) fail("invalid_transition", "handoff agent must differ from its predecessor");
}

function validatePredecessor(predecessor: HandoffIdentity["predecessor"]): void {
  if (!record(predecessor) || !record(predecessor.agent)) fail("invalid_transition", "handoff.predecessor.agent must be an object");
  nonempty("handoff.predecessor.agent.agentId", predecessor.agent.agentId);
  optionalNonempty("handoff.predecessor.executionId", predecessor.executionId);
  // Shape only: a cross-harness teleport keeps a predecessor conversation from another harness.
  if (predecessor.conversation !== undefined) validateConversationShape("handoff.predecessor.conversation", predecessor.conversation);
}

function validateBrief(brief: HandoffIdentity["brief"]): void {
  if (!record(brief)) fail("invalid_transition", "handoff.brief must be an object");
  nonempty("handoff.brief.ref", brief.ref);
  if (typeof brief.sha256 !== "string" || !SHA256_HEX.test(brief.sha256)) {
    fail("invalid_transition", "handoff.brief.sha256 must be 64 lowercase hex characters");
  }
  nonnegativeInteger("handoff.brief.bytes", brief.bytes);
}

/** The namespace an observed conversation must fall in; undefined for resume, which pins the whole identity. */
export function targetNamespace(target: LifecycleExecutionTarget): string | undefined {
  return target.kind === "resume" ? undefined : target.namespace;
}

/** Applies the target's namespace and distinctness rules to an observed conversation. */
export function requireTargetConversation(target: LifecycleExecutionTarget, conversation: ConversationIdentity, subject: string): void {
  const namespace = targetNamespace(target);
  if (namespace !== undefined && conversation.namespace !== namespace) {
    fail("invalid_transition", `${subject} namespace does not match ${target.kind} target namespace`);
  }
  const excluded = excludedConversation(target);
  if (excluded && sameConversation(excluded, conversation)) {
    fail("invalid_transition", `${subject} must differ from the ${target.kind} ${target.kind === "fork" ? "parent" : "predecessor"}`);
  }
}

function excludedConversation(target: LifecycleExecutionTarget): ConversationIdentity | undefined {
  if (target.kind === "fork") return target.parent;
  if (target.kind === "handoff") return target.handoff.predecessor.conversation;
  return undefined;
}

export function cloneTarget(target: LifecycleExecutionTarget): LifecycleExecutionTarget {
  switch (target.kind) {
    case "fresh":
      return { ...target };
    case "resume":
      return { kind: "resume", conversation: { ...target.conversation } };
    case "fork":
      return { ...target, parent: { ...target.parent } };
    case "handoff":
      return { ...target, handoff: cloneHandoff(target.handoff) };
  }
}

function cloneHandoff(handoff: HandoffIdentity): HandoffIdentity {
  const { predecessor, brief } = handoff;
  const conversation = predecessor.conversation ? { conversation: { ...predecessor.conversation } } : {};
  return { ...handoff, predecessor: { ...predecessor, agent: { ...predecessor.agent }, ...conversation }, brief: { ...brief } };
}
