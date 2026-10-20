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
