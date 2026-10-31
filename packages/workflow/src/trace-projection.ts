import { conversationRef, type ConversationIdentity, type ExecutionRecord, type UsageMeasurement } from "@titan-design/agent-protocol";
import { TRACE_SCHEMA_VERSION, TraceAttemptSchema, TraceRunSchema, type TraceAttempt, type TraceRecord, type TraceRun } from "@titan-design/agent-protocol/trace";
import type { GateStore } from "@titan-design/hitl";
import { isRecord } from "@titan-design/rpc-protocol/narrow";
import { pendingGateRecords, stepArtifactRecords, stepGateRecords } from "./trace-projection-gates.js";
import { usageFromMeasurements } from "./usage.js";
import { workflowStepRequestKey, type ActiveStep, type StepOperation, type StepResult, type StepUsage, type WorkflowRun } from "./types.js";

/** What a projection reads besides the run; structural, so workflow takes no runtime dependency on the ledger package. */
export interface RunTraceSources {
  gates: Pick<GateStore, "get">;
  executions?: { findByRequestKey(requestKey: string): ExecutionRecord | undefined };
  /** Hex sha256 of the text; injected so the projection stays pure. */
  digest(text: string): string;
}

type AttemptFields = Omit<TraceAttempt, "schema" | "kind" | "id" | "runId" | "at" | "stepId" | "iteration" | "attempt" | "stepKind">;
interface AttemptSlot { stepId: string; iteration: number; attempt: number; stepKind: StepOperation }

/**
 * Projects a stored run into strict trace records: the run first, then each recorded step's attempts, gates and
 * artifacts in recording order, then in-flight steps and the gate a paused run waits on.
 */
export function projectRunTrace(run: WorkflowRun, sources: RunTraceSources): TraceRecord[] {
  const records: TraceRecord[] = [runRecord(run, sources)];
  for (const [key, result] of Object.entries(run.stepResults)) {
    records.push(...resultAttempts(run, result, sources), ...stepGateRecords(run, key, result, stepKindOf(result), sources), ...stepArtifactRecords(key, result));
  }
  for (const step of Object.values(run.activeSteps)) records.push(...activeAttempts(run, step, sources));
  records.push(...pendingGateRecords(run, records, sources));
  return records;
}

function runRecord(run: WorkflowRun, sources: RunTraceSources): TraceRun {
  return TraceRunSchema.parse({
    schema: TRACE_SCHEMA_VERSION,
    kind: "run",
    id: run.id,
    runId: run.id,
    at: run.startedAt,
    workflowName: run.workflowName,
    status: run.status,
    completedAt: run.completedAt,
    error: run.error,
    paramsSha256: sources.digest(canonicalJson(run.params)),
  });
}

function canonicalJson(params: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

function resultAttempts(run: WorkflowRun, result: StepResult, sources: RunTraceSources): TraceAttempt[] {
  const slot: AttemptSlot = { stepId: result.stepId, iteration: result.iteration, attempt: result.attempt ?? 0, stepKind: stepKindOf(result) };
  const final = finalFields(result, sources);
  const ledger = slot.stepKind === "dispatch" ? ledgerAttempts(run, slot, sources, final) : [];
  if (ledger.length > 0) return ledger;
  return [attemptRecord(run, slot, result.startedAt ?? result.completedAt, { ...final, outcome: "succeeded", completedAt: result.completedAt, ...usageField(result.usage) })];
}

/** Results from before 0.5 carry no operation; only a dispatch has a runner id, and only a seed has output without one. */
function stepKindOf(result: StepResult): StepOperation {
  if (result.operation) return result.operation;
  if (result.agentId !== null) return "dispatch";
  return result.output === undefined ? "assisted" : "seed";
}

function finalFields(result: StepResult, sources: RunTraceSources): AttemptFields {
  return {
    signal: result.signal,
    agentId: result.agentId,
    ...(result.output === undefined ? {} : { outputSha256: sources.digest(result.output) }),
  };
}

function activeAttempts(run: WorkflowRun, step: ActiveStep, sources: RunTraceSources): TraceAttempt[] {
  const slot: AttemptSlot = { stepId: step.stepId, iteration: Number(step.iterKey.slice(step.iterKey.lastIndexOf(":") + 1)), attempt: step.attempt, stepKind: "dispatch" };
  const ledger = ledgerAttempts(run, slot, sources, {});
  if (ledger.some((attempt) => attempt.attempt === step.attempt)) return ledger;
  const fields: AttemptFields = {
    ...(step.kind === "recoverable" ? { executionId: step.executionId } : {}),
    ...(step.runnerRef ? { runnerRef: step.runnerRef } : {}),
    ...(step.recovery ? { recovery: { kind: step.recovery.kind, observedAt: step.recovery.observedAt } } : {}),
  };
  return [...ledger, attemptRecord(run, slot, step.startedAt, fields)];
}

/**
 * One record per ledger hit, probing past the final attempt until a key misses. A recovered retry resumes after the
 * attempt it found, so keys below the final attempt are probed even when one is missing.
 */
function ledgerAttempts(run: WorkflowRun, slot: AttemptSlot, sources: RunTraceSources, final: AttemptFields): TraceAttempt[] {
  if (!sources.executions) return [];
  const attempts: TraceAttempt[] = [];
  for (let attempt = 0; ; attempt += 1) {
    const record = sources.executions.findByRequestKey(workflowStepRequestKey(run.id, slot.stepId, slot.iteration, attempt));
    if (!record && attempt > slot.attempt) return attempts;
    if (!record) continue;
    const fields = { ...executionFields(record), ...(attempt === slot.attempt ? final : {}) };
    attempts.push(attemptRecord(run, { ...slot, attempt }, record.dispatchedAt ?? record.preparedAt, fields));
  }
}

function executionFields(record: ExecutionRecord): AttemptFields {
  const terminal = record.terminal;
  const conversation = conversationOf(record);
  return {
    executionId: record.execution.executionId,
    phase: record.phase,
    ...(record.runnerRef ? { runnerRef: record.runnerRef } : {}),
    ...(conversation ? { conversation: conversationRef(conversation) } : {}),
    ...(record.finishedAt ? { completedAt: record.finishedAt } : {}),
    ...(terminal ? { outcome: terminal.outcome === "ended" ? "failed" : terminal.outcome } : record.phase === "recovery_required" ? { outcome: "recovery_required" } : {}),
    ...(terminal?.outcome === "failed" ? { retryable: terminal.retryable } : {}),
    ...usageField(usageFromMeasurements(terminalMeasurements(terminal))),
  };
}

/** A succeeded terminal's result is the harness's own type; workflow reads its usage and conversation by shape. */
function succeededResult(terminal: ExecutionRecord["terminal"]): Record<string, unknown> {
  return terminal?.outcome === "succeeded" && isRecord(terminal.result) ? terminal.result : {};
}

function terminalMeasurements(terminal: ExecutionRecord["terminal"]): readonly UsageMeasurement[] {
  if (terminal?.outcome === "failed") return terminal.usage ?? [];
  const { usage } = succeededResult(terminal);
  return Array.isArray(usage) ? usage.filter(isMeasurement) : [];
}

function conversationOf(record: ExecutionRecord): ConversationIdentity | undefined {
  const { conversation } = succeededResult(record.terminal);
  if (isConversation(conversation)) return conversation;
  return record.execution.conversation ?? (record.target.kind === "resume" ? record.target.conversation : undefined);
}

function isMeasurement(value: unknown): value is UsageMeasurement {
  return isRecord(value) && (value.kind === "delta" || value.kind === "snapshot") && isRecord(value.tokens);
}

function isConversation(value: unknown): value is ConversationIdentity {
  return isRecord(value) && [value.harness, value.namespace, value.nativeId].every((part) => typeof part === "string" && part.length > 0);
}

/** The strict attempt usage has no `costUnknown`, so a floor cost is carried as the number alone. */
function usageField(usage: StepUsage | undefined): Pick<AttemptFields, "usage"> {
  if (!usage) return {};
  const { costUsd, inputTokens, outputTokens } = usage;
  return { usage: { costUsd, ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) } };
}

function attemptRecord(run: WorkflowRun, slot: AttemptSlot, at: string, fields: AttemptFields): TraceAttempt {
  return TraceAttemptSchema.parse({
    schema: TRACE_SCHEMA_VERSION,
    kind: "attempt",
    id: workflowStepRequestKey(run.id, slot.stepId, slot.iteration, slot.attempt),
    runId: run.id,
    at,
    ...slot,
    ...fields,
  });
}
