import { z } from "zod";
import { EXECUTION_PHASES, TERMINAL_EXECUTION_PHASES } from "../lifecycle.js";
import type { TerminalExecutionPhase } from "../lifecycle.js";
import { CORRELATION_KEY_PATTERN, MAX_CORRELATION_VALUE_LENGTH, MAX_CORRELATIONS } from "../lifecycle-correlations.js";
import {
  ATTEMPT_ID_PATTERN,
  CALL_ID_PATTERN,
  COMMIT_ID_PATTERN,
  COMMIT_SHA_PATTERN,
  CONVERSATION_REF_PATTERN,
  COST_ID_PATTERN,
  FILE_ID_PATTERN,
  HUMAN_GATE_ID_PATTERN,
  POLICY_GATE_ID_PATTERN,
  PR_ID_PATTERN,
  REPO_PATTERN,
  SHA256_PATTERN,
  TURN_REF_PATTERN,
} from "./ids.js";

export const TRACE_SCHEMA_VERSION = "titan.trace/v1";
export const TRACE_RECORD_KINDS = ["run", "attempt", "call", "gate", "artifact", "cost"] as const;
export const TRACE_ARTIFACT_KINDS = ["commit", "pr", "file"] as const;
/** Mirrors workflow's WorkflowStatus; agent-protocol sits below workflow, so the S2 contract test pins the match. */
export const TRACE_RUN_STATUSES = ["running", "paused", "cancelling", "recovery_required", "completed", "failed", "cancelled"] as const;
export const TRACE_STEP_KINDS = ["dispatch", "seed", "assisted", "authorize"] as const;
/** Mirrors hitl's GateStatus for the same tier reason. */
export const TRACE_GATE_STATUSES = ["pending", "resolved", "cancelled", "expired"] as const;
export const TRACE_GATE_VERDICTS = ["allow", "deny", "revise"] as const;
export const TRACE_CHECK_STATES = ["passing", "failing", "pending"] as const;
/** workflow's DurableStepOutcome kinds are the execution terminals a step can report, plus recovery. */
const ATTEMPT_OUTCOMES = [
  ...TERMINAL_EXECUTION_PHASES.filter((phase): phase is Exclude<TerminalExecutionPhase, "ended"> => phase !== "ended"),
  "recovery_required",
] as const;

export type TraceParseMode = "strict" | "loose";

const nonempty = z.string().min(1);
const timestamp = z.iso.datetime({ offset: true });
const sha256 = z.string().regex(SHA256_PATTERN);
const count = z.number().int().nonnegative();
const tokenCount = count.nullable();

function objectFor(mode: TraceParseMode) {
  return mode === "strict" ? z.strictObject : z.looseObject;
}

function sharedSchemas(mode: TraceParseMode) {
  const object = objectFor(mode);
  const span = object({ sourceId: nonempty, byteOffset: count, byteLength: count, contentHash: sha256 });
  const usageBase = {
    model: z.string().nullable(),
    tokens: object({
      input: tokenCount,
      output: tokenCount,
      cachedInput: tokenCount,
      cacheWriteInput: tokenCount,
      reasoningOutput: tokenCount,
      total: tokenCount,
    }),
    cost: object({ usd: z.number().nonnegative(), kind: z.enum(["estimate", "reported"]) }).nullable(),
    source: nonempty,
  };
  const measurement = z.discriminatedUnion("kind", [
    object({ ...usageBase, kind: z.literal("delta"), responseId: nonempty }),
    object({ ...usageBase, kind: z.literal("snapshot"), scope: z.enum(["turn", "conversation"]), scopeId: nonempty, epoch: nonempty, sequence: count }),
  ]);
  return { object, span, measurement };
}

function envelope<K extends (typeof TRACE_RECORD_KINDS)[number]>(kind: K, id: RegExp, step: boolean) {
  const base = { schema: z.literal(TRACE_SCHEMA_VERSION), kind: z.literal(kind), id: z.string().regex(id), runId: nonempty, at: timestamp };
  return step ? { ...base, attemptId: z.string().regex(ATTEMPT_ID_PATTERN).optional() } : base;
}

const correlations = z
  .record(z.string().regex(CORRELATION_KEY_PATTERN), z.string().min(1).max(MAX_CORRELATION_VALUE_LENGTH))
  .refine((value) => Object.keys(value).length <= MAX_CORRELATIONS, `at most ${MAX_CORRELATIONS} correlations`);

function runSchema(mode: TraceParseMode) {
  return objectFor(mode)({
    ...envelope("run", /^\S+$/, false),
    workflowName: nonempty,
    status: z.enum(TRACE_RUN_STATUSES),
    completedAt: timestamp.nullable().optional(),
    error: z.string().nullable().optional(),
    correlations: correlations.optional(),
    paramsSha256: sha256.optional(),
  });
}

function attemptSchema(mode: TraceParseMode) {
  const object = objectFor(mode);
  return object({
    ...envelope("attempt", ATTEMPT_ID_PATTERN, false),
    stepId: nonempty,
    iteration: count,
    attempt: count,
    stepKind: z.enum(TRACE_STEP_KINDS),
    executionId: nonempty.optional(),
    phase: z.enum(EXECUTION_PHASES).optional(),
    outcome: z.enum(ATTEMPT_OUTCOMES).optional(),
    retryable: z.boolean().optional(),
    error: z.string().optional(),
    signal: z.string().nullable().optional(),
    runnerRef: nonempty.optional(),
    agentId: z.string().nullable().optional(),
    conversation: z.string().regex(CONVERSATION_REF_PATTERN).optional(),
    model: nonempty.optional(),
    completedAt: timestamp.optional(),
    usage: object({ costUsd: z.number().nonnegative(), inputTokens: count.optional(), outputTokens: count.optional() }).optional(),
    recovery: object({ kind: z.enum(["legacy_unrecoverable", "not_found", "ownership_lost", "unknown"]), observedAt: timestamp }).optional(),
    promptSha256: sha256.optional(),
    outputSha256: sha256.optional(),
  });
}

function callGateCostSchemas(mode: TraceParseMode) {
  const { object, span, measurement } = sharedSchemas(mode);
  const call = object({
    ...envelope("call", CALL_ID_PATTERN, true),
    callKind: z.enum(["model", "tool"]),
    name: nonempty,
    namespace: z.string().nullable().optional(),
    conversation: z.string().regex(CONVERSATION_REF_PATTERN),
    turn: z.string().regex(TURN_REF_PATTERN).optional(),
    isError: z.boolean().nullable().optional(),
    span,
  });
  const gate = object({
    ...envelope("gate", /^\S+$/, true),
    gateKind: z.enum(["human", "policy"]),
    status: z.enum(TRACE_GATE_STATUSES).optional(),
    verdict: z.enum(TRACE_GATE_VERDICTS).nullable().optional(),
    decidedBy: z.string().regex(/^(?:human|policy|agent):\S+$/).optional(),
    policyRule: object({ table: nonempty, rowId: nonempty, version: count }).optional(),
    resolvedAt: timestamp.optional(),
    expiresAt: timestamp.optional(),
    reason: z.string().optional(),
    promptSha256: sha256.optional(),
    payloadSha256: sha256.optional(),
  }).check((ctx) => {
    const pattern = ctx.value.gateKind === "policy" ? POLICY_GATE_ID_PATTERN : HUMAN_GATE_ID_PATTERN;
    if (!pattern.test(ctx.value.id)) ctx.issues.push({ code: "custom", message: `id does not match the ${ctx.value.gateKind} gate grammar`, input: ctx.value.id, path: ["id"] });
  });
  const cost = object({ ...envelope("cost", COST_ID_PATTERN, true), conversation: z.string().regex(CONVERSATION_REF_PATTERN), measurement, span: span.optional() });
  return { call, gate, cost };
}

function artifactSchema(mode: TraceParseMode) {
  const { object, span } = sharedSchemas(mode);
  const base = { repo: z.string().regex(REPO_PATTERN), span: span.optional() };
  const commitId = z.string().regex(COMMIT_ID_PATTERN);
  return z.discriminatedUnion("artifactKind", [
    object({ ...envelope("artifact", COMMIT_ID_PATTERN, true), ...base, artifactKind: z.literal("commit"), sha: z.string().regex(COMMIT_SHA_PATTERN), branch: z.string().regex(/^branch:\S+$/).optional(), reverts: commitId.optional() }),
    object({
      ...envelope("artifact", PR_ID_PATTERN, true),
      ...base,
      artifactKind: z.literal("pr"),
      number: z.number().int().positive(),
      state: z.string().nullable().optional(),
      mergedAt: timestamp.nullable().optional(),
      closedAt: timestamp.nullable().optional(),
      reviewRounds: count.nullable().optional(),
      checks: z.enum(TRACE_CHECK_STATES).nullable().optional(),
    }),
    object({ ...envelope("artifact", FILE_ID_PATTERN, true), ...base, artifactKind: z.literal("file"), path: nonempty, commit: commitId.optional(), lines: z.array(object({ lineStart: z.number().int().positive(), lineEnd: z.number().int().positive() })).optional() }),
  ]);
}

export function buildTraceSchemas(mode: TraceParseMode) {
  const { span, measurement } = sharedSchemas(mode);
  const run = runSchema(mode);
  const attempt = attemptSchema(mode);
  const { call, gate, cost } = callGateCostSchemas(mode);
  const artifact = artifactSchema(mode);
  const record = z.discriminatedUnion("kind", [run, attempt, call, gate, artifact, cost]);
  return { span, measurement, run, attempt, call, gate, artifact, cost, record };
}
