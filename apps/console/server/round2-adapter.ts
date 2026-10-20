// TP-3232 (V1-2, the review-schema 0.3.x bump) deletes this file: the pinned 0.1.0 refuses the feedback@1 answer fields `rounds.submit` writes.
/**
 * What the owner posts to `rounds.submit`, checked strictly. `round-feedback.ts` builds `feedback.json` from it and
 * `round-schema.ts`'s 0.3 `FeedbackSchema` checks the result. The round.json half is gone; manifests parse through
 * `round-schema.ts`.
 */
import { z } from "zod";

export const FEEDBACK_SCHEMA_ID = "titan-review/feedback@1";

/** What the owner sends for one question; the server adds the recommendation echo, `agreed`, `after` and `recommendationSeen` itself. */
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

/** Bounds that keep a 24-frame round's feedback under `rounds-submit.ts`'s write cap in ordinary use. */
const MAX_FRAME_COMMENT_CHARS = 2000;
const MAX_PIN_NOTE_CHARS = 500;
const MAX_PINS_PER_FRAME = 12;

/** One numbered pin as review-schema 0.3's `Annotation`; `rounds-submit.ts` checks its id belongs to its frame. */
const PostedAnnotation = z.strictObject({
  id: z.string().min(1).max(200),
  width: z.number().int().positive(),
  x: z.number(),
  y: z.number(),
  xPct: z.number().min(0).max(1),
  yPct: z.number().min(0).max(1),
  target: z.strictObject({ testId: z.string().optional(), role: z.string().optional(), text: z.string().optional() }).optional(),
  note: z.string().max(MAX_PIN_NOTE_CHARS),
});

/** What the owner sends for one frame; the server adds its source echo and `relatedQuestionIds` itself. */
export const PostedVariant = z.strictObject({
  key: z.string().min(1),
  verdict: z.enum(["chosen", "rejected", "maybe"]).nullable().optional(),
  comment: z.string().max(MAX_FRAME_COMMENT_CHARS).optional(),
  annotations: z.array(PostedAnnotation).max(MAX_PINS_PER_FRAME).optional(),
});

export type PostedVariant = z.infer<typeof PostedVariant>;
