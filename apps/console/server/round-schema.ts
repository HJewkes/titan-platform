/**
 * The console's one round.json schema: review-schema 0.3.0's strict `RoundSchema`, vendored in `review-schema-0.3/`
 * because 0.3.0 is not on npm yet. It is a product-side adapter, so TP-3232 points this file at the release and
 * deletes the vendored directory; `round-schema.sunset.test.ts` fails the day the installed package makes that possible.
 *
 * A blind-ab round is refused. Its takes name their engines, the page must never see them, and the console
 * keeps no blind key, so the review harness answers those rounds. Feedback with a blind-ab answer (`pairs`,
 * whose `engine` the harness fills in after the send) is refused for the same reason.
 */
import { z } from "zod";
import * as reviewSchema from "./review-schema-0.3/index.js";

export const BLIND_AB_REFUSED = "a blind-ab round is answered in the review harness";

const answeredHere = <Q extends { kind: string }>(question: Q): question is Exclude<Q, { kind: "blind-ab" }> => question.kind !== "blind-ab";

export const RoundSchema = reviewSchema.RoundSchema.transform((manifest, ctx) => {
  const { questions } = manifest;
  if (questions.every(answeredHere)) return { ...manifest, questions };
  ctx.issues.push({ code: "custom", path: ["questions"], message: BLIND_AB_REFUSED, input: questions });
  return z.NEVER;
});

const notBlindAb = (answer: { pairs?: unknown }): boolean => answer.pairs === undefined;

export const FeedbackSchema = reviewSchema.FeedbackSchema.refine((feedback) => feedback.answers.every(notBlindAb), {
  path: ["answers"],
  message: BLIND_AB_REFUSED,
});

export type Feedback = z.output<typeof FeedbackSchema>;
export type Manifest = z.output<typeof RoundSchema>;
export type Question = Manifest["questions"][number];
export type Section = reviewSchema.Section;
