import { z } from "zod";
import type { ExecutionRecord, ExecutionTransition } from "./lifecycle.js";
import { EXECUTION_PHASES } from "./lifecycle.js";
import { UsageMeasurementSchema } from "./source-schema.js";

// Loose objects throughout: rows written by a newer writer keep their unknown keys.
const text = z.string();
const count = z.number();

const conversation = z.looseObject({ harness: text, namespace: text, nativeId: text });
const agent = z.looseObject({ agentId: text });
const execution = z.looseObject({ executionId: text, conversation: conversation.optional() });
const surface = z.looseObject({ kind: text, host: text, nativeId: text, owned: z.boolean() });
const fence = z.looseObject({ supervisorId: text, generation: count });
const lease = z.looseObject({ supervisorId: text, generation: count, leaseUntil: text });
const correlations = z.record(z.string(), z.string());
const usage = UsageMeasurementSchema;

const target = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("fresh"), namespace: text, pinnedNativeId: text.optional() }),
  z.looseObject({ kind: z.literal("resume"), conversation }),
  z.looseObject({ kind: z.literal("fork"), namespace: text, parent: conversation }),
  z.looseObject({
    kind: z.literal("handoff"),
    namespace: text,
    handoff: z.looseObject({
      handoffId: text,
      lineageId: text,
      generation: count,
      predecessor: z.looseObject({ agent, executionId: text.optional(), conversation: conversation.optional() }),
      brief: z.looseObject({ ref: text, sha256: text, bytes: count }),
    }),
  }),
]);

function terminalSchema<TResult>(result: z.ZodType<TResult>) {
  return z.discriminatedUnion("outcome", [
    z.looseObject({ outcome: z.literal("succeeded"), result }),
    z.looseObject({ outcome: z.literal("failed"), reason: text, retryable: z.boolean(), usage: z.array(usage).optional() }),
    z.looseObject({ outcome: z.literal("cancelled"), reason: text }),
    z.looseObject({ outcome: z.literal("cancellation_unknown"), reason: text, evidence: text, usage: z.array(usage).optional() }),
    z.looseObject({
      outcome: z.literal("ended"),
      evidence: text,
      exit: z.looseObject({ code: count.nullable(), signal: text.nullable() }).optional(),
    }),
  ]);
}

/** Reads an execution record from storage; `result` is the schema for the opaque terminal result. */
export function executionRecordSchema<TResult>(result: z.ZodType<TResult>): z.ZodType<ExecutionRecord<TResult>> {
  return z.looseObject({
    execution,
    agent: agent.optional(),
    harness: text,
    requestKey: text,
    target,
    phase: z.enum(EXECUTION_PHASES),
    revision: count,
    ownerGeneration: count,
    owner: lease.optional(),
    runnerRef: text.optional(),
    adapterExecution: execution.optional(),
    surface: surface.optional(),
    preparedAt: text,
    dispatchedAt: text.optional(),
    cancellation: z.looseObject({ requestedAt: text, reason: text }).optional(),
    recovery: z.looseObject({ requiredAt: text, evidence: text }).optional(),
    finishedAt: text.optional(),
    lastObservedAt: text,
    terminal: terminalSchema(result).optional(),
    correlations: correlations.optional(),
  });
}

const envelope = { executionId: text, eventId: text, expectedRevision: count, occurredAt: text };

const plainTransitions = [
  z.looseObject({
    ...envelope,
    kind: z.literal("prepare"),
    expectedRevision: z.literal(0),
    execution,
    agent: agent.optional(),
    harness: text,
    requestKey: text,
    target,
    owner: lease,
    correlations: correlations.optional(),
  }),
  z.looseObject({ ...envelope, kind: z.literal("begin_dispatch"), fence }),
  z.looseObject({
    ...envelope,
    kind: z.literal("observe_running"),
    fence,
    runnerRef: text,
    adapterExecution: execution,
    conversation: conversation.optional(),
    surface: surface.optional(),
    evidence: text,
  }),
  z.looseObject({ ...envelope, kind: z.literal("observe_launched"), fence, runnerRef: text, surface, evidence: text }),
  z.looseObject({ ...envelope, kind: z.literal("identify_conversation"), fence, conversation }),
  z.looseObject({ ...envelope, kind: z.literal("request_cancellation"), fence, reason: text }),
  z.looseObject({ ...envelope, kind: z.literal("require_recovery"), fence, evidence: text }),
  z.looseObject({ ...envelope, kind: z.literal("claim_owner"), owner: lease }),
  z.looseObject({ ...envelope, kind: z.literal("renew_owner"), fence, leaseUntil: text }),
  z.looseObject({ ...envelope, kind: z.literal("release_owner"), fence }),
] as const;

function finishTransition<TResult>(result: z.ZodType<TResult>) {
  return z.looseObject({
    ...envelope,
    kind: z.literal("finish"),
    fence,
    terminal: terminalSchema(result),
    adapterExecution: execution.optional(),
    conversation: conversation.optional(),
  });
}

/** Reads a stored transition; `result` is the schema for the opaque terminal result of a `finish`. */
export function executionTransitionSchema<TResult>(result: z.ZodType<TResult>): z.ZodType<ExecutionTransition<TResult>> {
  return z.discriminatedUnion("kind", [...plainTransitions, finishTransition(result)]);
}

/** Terminal results are opaque to the protocol; callers narrow them with their own schema. */
export const ExecutionRecordSchema = executionRecordSchema(z.unknown());
export const ExecutionTransitionSchema = executionTransitionSchema(z.unknown());
