import { z } from "zod";
import { buildTraceSchemas, TRACE_ARTIFACT_KINDS, TRACE_RECORD_KINDS, TRACE_SCHEMA_VERSION } from "./schema.js";
import { ATTEMPT_ID_PATTERN } from "./ids.js";

export {
  TRACE_ARTIFACT_KINDS,
  TRACE_CHECK_STATES,
  TRACE_GATE_STATUSES,
  TRACE_GATE_VERDICTS,
  TRACE_RECORD_KINDS,
  TRACE_RUN_STATUSES,
  TRACE_SCHEMA_VERSION,
  TRACE_STEP_KINDS,
} from "./schema.js";
export type { TraceParseMode } from "./schema.js";
export {
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
  commitRef,
  costId,
  policyGateId,
} from "./ids.js";
export { REDACTED_LOCAL_VALUE, TRACE_FIELD_PRIVACY, redactTraceRecord, tracePrivacyScope } from "./privacy.js";
export type { RedactTraceOptions, TracePrivacyClass, TracePrivacyScope } from "./privacy.js";

const strict = buildTraceSchemas("strict");
const loose = buildTraceSchemas("loose");

/** Producer schemas: unknown keys are rejected. */
export const TranscriptSpanSchema = strict.span;
export const TraceUsageMeasurementSchema = strict.measurement;
export const TraceRunSchema = strict.run;
export const TraceAttemptSchema = strict.attempt;
export const TraceCallSchema = strict.call;
export const TraceGateSchema = strict.gate;
export const TraceArtifactSchema = strict.artifact;
export const TraceCostSchema = strict.cost;
export const TraceRecordSchema = strict.record;

/** The fields every kind shares; extra keys pass so any record can be read as its envelope. */
export const TraceEnvelopeSchema = z.looseObject({
  schema: z.literal(TRACE_SCHEMA_VERSION),
  kind: z.enum(TRACE_RECORD_KINDS),
  id: z.string().min(1),
  runId: z.string().min(1),
  attemptId: z.string().regex(ATTEMPT_ID_PATTERN).optional(),
  at: z.iso.datetime({ offset: true }),
});

export type TranscriptSpan = z.infer<typeof TranscriptSpanSchema>;
export type TraceEnvelope = z.infer<typeof TraceEnvelopeSchema>;
export type TraceRun = z.infer<typeof TraceRunSchema>;
export type TraceAttempt = z.infer<typeof TraceAttemptSchema>;
export type TraceCall = z.infer<typeof TraceCallSchema>;
export type TraceGate = z.infer<typeof TraceGateSchema>;
export type TraceArtifact = z.infer<typeof TraceArtifactSchema>;
export type TraceCost = z.infer<typeof TraceCostSchema>;
export type TraceRecord = z.infer<typeof TraceRecordSchema>;
export type TraceRecordKind = TraceRecord["kind"];

/** A record of a kind this version does not know, kept whole for a later reader. */
export interface UnknownTraceRecord {
  kind: "unknown";
  value: unknown;
}

export type LooseTraceRecord = z.infer<typeof loose.record> | UnknownTraceRecord;

export function parseTraceRecord(value: unknown): TraceRecord {
  return TraceRecordSchema.parse(value);
}

/** Consumer parse: unknown keys are kept, an unknown kind comes back as `{ kind: "unknown" }`, a known kind must still be valid. */
export function parseTraceRecordLoose(value: unknown): LooseTraceRecord {
  return isKnownKind(value) ? loose.record.parse(value) : { kind: "unknown", value };
}

function isKnownKind(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const { kind, artifactKind } = value as { kind?: unknown; artifactKind?: unknown };
  if (!includes(TRACE_RECORD_KINDS, kind)) return false;
  return kind !== "artifact" || includes(TRACE_ARTIFACT_KINDS, artifactKind);
}

function includes(values: readonly string[], value: unknown): boolean {
  return typeof value === "string" && values.includes(value);
}
