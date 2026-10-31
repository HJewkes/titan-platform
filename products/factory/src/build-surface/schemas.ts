import { z } from "zod";

const Sha = z.string().regex(/^[0-9a-f]{40}$/, "a full 40-character commit sha");

/** The fenced JSON an implementer ends each round with (HA-46 OD2's `bs-implement` output). */
export const ImplementerReportSchema = z.object({
  head: Sha,
  targetsCovered: z.array(z.string()).default([]),
  newPrimitivesRequested: z.array(z.string()).default([]),
  deviations: z.array(z.object({ part: z.string(), measurement: z.string() })).default([]),
  ideas: z.array(z.string()).default([]),
  evidenceRun: z.string().optional(),
});
export type ImplementerReport = z.infer<typeof ImplementerReportSchema>;

/** Loose on purpose: a class this build does not know still parses, and `gateFailureClass` gives it the default route. */
const GateFailureSchema = z.looseObject({ class: z.string().optional(), signature: z.string().optional() });

/** One `<gate>.json` the repo's gate command writes; `score` lets the fix loop see progress on a failing gate, and `failure` routes it (null, as the gate README writes a pass, means none). */
export const GateEvidenceSchema = z.looseObject({ gate: z.string().min(1), head: z.string(), pass: z.boolean(), score: z.number().optional(), failure: GateFailureSchema.nullish() });
export type GateEvidence = z.infer<typeof GateEvidenceSchema>;

export const GateRunSchema = z.object({
  head: Sha,
  /** 0 passes; 3 means a gate's sensitivity proof failed, so the gate itself is broken. */
  exitCode: z.number().int(),
  pass: z.boolean(),
  gates: z.array(z.object({ gate: z.string(), pass: z.boolean(), score: z.number().optional(), failure: GateFailureSchema.optional(), evidence: z.string() })),
  problems: z.array(z.string()),
});
export type GateRun = z.infer<typeof GateRunSchema>;

export const ReviewRowSchema = z.object({
  rubric: z.number().int().min(1),
  result: z.enum(["pass", "fail"]),
  file: z.string().optional(),
  line: z.number().int().optional(),
  repro: z.string().optional(),
});

/** The fenced JSON a reviewer ends with (G11): one row per rubric item, at the exact head it reviewed. */
export const ReviewReportSchema = z.object({ head: Sha, verdict: z.enum(["PASS", "BLOCK"]), rows: z.array(ReviewRowSchema) });
export type ReviewReport = z.infer<typeof ReviewReportSchema>;

/** What a validator command said: accepted, or one rejection per line of its stdout. */
export const ValidationSchema = z.object({ accepted: z.boolean(), rejections: z.array(z.string()) });
export type Validation = z.infer<typeof ValidationSchema>;

export const AgentStepSchema = <T extends z.ZodType>(report: T) => z.object({ agent: z.string(), sessionId: z.string(), report });

export const PreviewSchema = z.object({ pass: z.boolean(), detail: z.string() });
/** `green` is the gate evidence already recorded at an existing branch's head when every gate there passed. */
export const BranchSchema = z.object({
  branch: z.string(),
  baseSha: Sha,
  created: z.boolean(),
  green: GateRunSchema.optional(),
  /** Set when an earlier run already merged this slice: its PR landed, or the branch head is in the base. */
  merged: z.object({ pr: z.number().int().positive(), mergeSha: Sha, head: Sha }).optional(),
});
export const PrSchema = z.object({ pr: z.number().int().positive(), url: z.string(), created: z.boolean() });
export const RegisteredSchema = z.object({ runId: z.string() });
export const LandStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("merged"), mergeSha: Sha }),
  z.object({ state: z.literal("stopped"), reason: z.string() }),
  z.object({ state: z.literal("moved"), head: Sha }),
]);
export type LandState = z.infer<typeof LandStateSchema>;
export const CommandResultSchema = z.object({ pass: z.boolean(), status: z.number().int(), detail: z.string() });
/** `task` is the filed `<initiative>/<id>`, or null with why it could not be filed. */
export const FiledTaskSchema = z.object({ task: z.string().nullable(), detail: z.string() });
export const ExtractSchema = z.object({ targets: z.unknown(), costUsd: z.number().optional() });
export const PlanSchema = z.object({ spec: z.unknown() });

export const DeviceAnswer = (headSha: string) => z.object({ decision: z.enum(["pass", "fail"]), headSha: z.literal(headSha), note: z.string().optional() });
export const InfraParkAnswer = (headSha: string) => z.object({ decision: z.enum(["retry", "stop"]), headSha: z.literal(headSha) });
export const DeployAnswer = (headSha: string) => z.object({ decision: z.enum(["deploy", "skip"]), headSha: z.literal(headSha) });
export const FinalWalkAnswer = (headSha: string) => z.object({ decision: z.enum(["accept", "changes"]), headSha: z.literal(headSha), notes: z.string().optional() });
