import { TRACE_GATES_KEY, workflowStepRequestKey } from "@titan-design/workflow";

/** Bumped when a record's shape changes, so a reader can refuse records it does not understand. */
export const EVIDENCE_VERSION = 1;

/** `StepResult.data` keys the F3 trace projection reads artifacts and policy decisions from. */
export const TRACE_DATA_KEYS = {
  artifacts: "titan.trace.artifacts",
  gates: TRACE_GATES_KEY,
} as const;

/** Where a record sits in the trace: the run is the trace, one step attempt is the span. */
export interface TraceRef {
  traceId: string;
  spanId: string;
}

export interface StepAttempt {
  runId: string;
  stepId: string;
  iteration: number;
  attempt: number;
}

/** The F3 seam: span ids follow the trace schema's attempt grammar, which is the runtime's own request key. */
export function traceRef(step: StepAttempt): TraceRef {
  return { traceId: step.runId, spanId: workflowStepRequestKey(step.runId, step.stepId, step.iteration, step.attempt) };
}

export type EvidenceRecord<K extends string = string, B extends object = Record<string, unknown>> = {
  v: typeof EVIDENCE_VERSION;
  kind: K;
  at: string;
} & TraceRef & B;

export function evidenceRecord<K extends string, B extends object>(kind: K, step: StepAttempt, at: string, body: B): EvidenceRecord<K, B> {
  return { ...body, v: EVIDENCE_VERSION, kind, at, ...traceRef(step) };
}
