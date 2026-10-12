import { TRACE_SCHEMA_VERSION, TraceArtifactSchema, TraceGateSchema, type TraceArtifact, type TraceGate, type TraceRecord } from "@titan-design/agent-protocol/trace";
import type { GateRecord, GateResolver, GateStore } from "@titan-design/hitl";
import { TRACE_ARTIFACTS_KEY, TRACE_GATES_KEY } from "./authorize.js";
import { assistedGateId, gateIdFor, memoKey, pendingGateId } from "./gate-ids.js";
import { workflowStepRequestKey, type StepOperation, type StepResult, type WorkflowRun } from "./types.js";

/** The slice of the projection's sources a gate record reads. */
export interface GateTraceSources {
  gates: Pick<GateStore, "get">;
  digest(text: string): string;
}

interface GateSlot { stepId: string; iteration: number }

/** A recorded step's gates: the policy decisions its data carries, then the human gate it waited on. */
export function stepGateRecords(run: WorkflowRun, key: string, result: StepResult, stepKind: StepOperation, sources: GateTraceSources): TraceGate[] {
  const policy = dataRecords(key, result, TRACE_GATES_KEY, (value) => TraceGateSchema.parse(value));
  const gateId = humanGateId(run, result, stepKind, sources.gates);
  const gate = gateId === undefined ? undefined : sources.gates.get(gateId);
  return gate ? [...policy, humanGateRecord(run, result, gate, sources)] : policy;
}

export function stepArtifactRecords(key: string, result: StepResult): TraceArtifact[] {
  return dataRecords(key, result, TRACE_ARTIFACTS_KEY, (value) => TraceArtifactSchema.parse(value));
}

/** The gate a paused run waits on, unless a recorded step already projected it. */
export function pendingGateRecords(run: WorkflowRun, projected: readonly TraceRecord[], sources: GateTraceSources): TraceGate[] {
  const stepId = run.currentStep;
  if (run.status !== "paused" || stepId === null) return [];
  const gateId = pendingGateId(run, stepId, (id) => sources.gates.get(id)?.status === "pending");
  const gate = sources.gates.get(gateId);
  if (gate?.status !== "pending" || projected.some((record) => record.kind === "gate" && record.id === gateId)) return [];
  const suffix = gateId.slice(gateIdFor(run.id, stepId).length);
  return [humanGateRecord(run, { stepId, iteration: suffix ? Number(suffix.slice(1)) : 0 }, gate, sources)];
}

/**
 * An assisted step's gate sits where `assistedGateId` put it; a run paused by 0.2.x left it on the bare id, which
 * is settled by now, so the fallback asks whether the gate exists rather than whether it is pending.
 */
function humanGateId(run: WorkflowRun, result: StepResult, stepKind: StepOperation, gates: GateTraceSources["gates"]): string | undefined {
  if (stepKind === "authorize") return typeof result.data?.gateId === "string" ? result.data.gateId : undefined;
  if (stepKind !== "assisted") return undefined;
  const current = gateIdFor(run.id, memoKey("assisted", result.stepId, result.iteration));
  if (gates.get(current)) return current;
  return assistedGateId(run, result.stepId, result.iteration, (id) => gates.get(id) !== undefined);
}

/** The prompt and payload are free text, so the record carries their digests only; the human's verdict stays unset. */
function humanGateRecord(run: WorkflowRun, slot: GateSlot, gate: GateRecord, sources: GateTraceSources): TraceGate {
  return TraceGateSchema.parse({
    schema: TRACE_SCHEMA_VERSION,
    kind: "gate",
    id: gate.id,
    runId: run.id,
    attemptId: workflowStepRequestKey(run.id, slot.stepId, slot.iteration, 0),
    at: gate.createdAt,
    gateKind: "human",
    status: gate.status,
    ...(gate.resolvedBy ? { decidedBy: decidedBy(gate.resolvedBy) } : {}),
    ...(gate.resolvedAt ? { resolvedAt: gate.resolvedAt } : {}),
    ...(gate.expiresAt ? { expiresAt: gate.expiresAt } : {}),
    ...(gate.reason === undefined ? {} : { reason: gate.reason }),
    promptSha256: sources.digest(gate.prompt),
    ...(gate.payload === undefined || gate.payload === null ? {} : { payloadSha256: sources.digest(canonicalJson(gate.payload)) }),
  });
}

function decidedBy(resolver: GateResolver): string {
  return resolver.class.startsWith("owner-") ? "human:owner" : `agent:${resolver.id}`;
}

/** Sorted keys at every depth, so a payload read back from SQLite digests the same as the one written. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );
}

/** A producer's record that fails its strict schema is a bug to surface, not data to drop. */
function dataRecords<T>(key: string, result: StepResult, dataKey: string, parse: (value: unknown) => T): T[] {
  const entries = result.data?.[dataKey];
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) throw new Error(`step ${result.stepId} (${key}): ${dataKey} is not an array`);
  return entries.map((entry, index) => {
    try {
      return parse(entry);
    } catch (error) {
      throw new Error(`step ${result.stepId} (${key}): ${dataKey}[${index}] is not a strict trace record: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
