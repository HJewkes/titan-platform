// TP-3232 (V1-2, the review-schema 0.3.x bump) deletes this file: the pinned 0.1.0 refuses current round@2 manifests and feedback@1 answer fields.
/**
 * The few round@2 and feedback@1 fields `rounds.submit` reads and writes, checked structurally.
 * A manifest is loose, as only these fields are read; an answer and the feedback written are
 * strict, a subset of feedback@1, so nothing the schema does not name reaches `feedback.json`.
 */
import { z } from "zod";

const MANIFEST_SCHEMA_ID = "titan-review/round@2";
export const FEEDBACK_SCHEMA_ID = "titan-review/feedback@1";

const mergeBinding = z.looseObject({
  repo: z.string(),
  pr: z.number().int(),
  headSha: z.string(),
  ship: z.array(z.string()),
});

const roundQuestion = z.looseObject({
  id: z.string(),
  kind: z.string(),
  options: z.array(z.string()).optional(),
  recommendation: z.unknown().optional(),
  merge: mergeBinding.optional(),
});

export const Round2Manifest = z.looseObject({
  schema: z.literal(MANIFEST_SCHEMA_ID),
  unit: z.string(),
  round: z.number().int(),
  recommendations: z.enum(["after-answer", "shown"]).optional(),
  variants: z.array(z.unknown()),
  questions: z.array(roundQuestion),
});

export type Round2Manifest = z.infer<typeof Round2Manifest>;
export type Round2Question = z.infer<typeof roundQuestion>;

/** What the owner sends for one question; the server adds `recommendationSeen` itself. */
export const SubmittedAnswer = z.strictObject({
  questionId: z.string().min(1),
  pick: z.string().optional(),
  revisionRequested: z.literal(true).optional(),
  picks: z.array(z.string()).optional(),
  value: z.number().optional(),
  text: z.string().optional(),
  comment: z.string().optional(),
  optionNotes: z.array(z.strictObject({ option: z.string(), note: z.string().min(1) })).optional(),
});

export type SubmittedAnswer = z.infer<typeof SubmittedAnswer>;

const writtenAnswer = SubmittedAnswer.extend({ recommendationSeen: z.literal(true).optional() });

export const FeedbackDocument = z.strictObject({
  schema: z.literal(FEEDBACK_SCHEMA_ID),
  unit: z.string(),
  round: z.number().int(),
  manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
  submittedAt: z.iso.datetime(),
  answers: z.array(writtenAnswer),
  variants: z.array(z.never()),
  general: z.string(),
});

export type FeedbackDocument = z.infer<typeof FeedbackDocument>;
