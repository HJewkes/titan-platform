// TP-3232 (V1-2, the review-schema 0.3.x bump) deletes this file: the pinned 0.1.0 refuses the feedback@1 answer fields `rounds.submit` writes.
/**
 * The feedback@1 half `rounds.submit` writes, checked strictly: an answer and the feedback written
 * are a subset of feedback@1, so nothing the schema does not name reaches `feedback.json`. The
 * round.json half is gone; manifests parse through `round-schema.ts`.
 */
import { z } from "zod";

export const FEEDBACK_SCHEMA_ID = "titan-review/feedback@1";

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
