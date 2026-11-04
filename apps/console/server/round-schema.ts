/**
 * The console's one round.json schema: review-schema 0.3.0's strict `RoundSchema`, vendored in `review-schema-0.3/`
 * because 0.3.0 is not on npm yet. It is a product-side adapter, so TP-3232 points this file at the release and
 * deletes the vendored directory; `round-schema.sunset.test.ts` fails the day the installed package makes that possible.
 *
 * A blind-ab round is refused. Its takes name their engines, the page must never see them, and the console
 * keeps no blind key, so the review harness answers those rounds. Feedback with a blind-ab answer (`pairs`,
 * whose `engine` the harness fills in after the send) is refused for the same reason.
 *
 * `supersedes` (TP-3990) is the console's own field, not review-schema's: the ids of earlier rounds this one replaces,
 * which `round-supersede.ts` withdraws while they are still open. It is lifted off before the strict parse, so the
 * vendored copy stays byte-for-byte the release and survives TP-3232's swap. `planApprovals` (TP-4357) is lifted the same
 * way: the plan-approval entries a plan round's answer records (`round-plan-binding.ts`).
 */
import { z } from "zod";
import * as reviewSchema from "./review-schema-0.3/index.js";
import { PlanBindings, planBindingProblems } from "./round-plan-binding.js";

export const BLIND_AB_REFUSED = "a blind-ab round is answered in the review harness";
/** A round directory's name: no dot, no slash. */
export const ROUND_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_SUPERSEDES = 50;

const answeredHere = <Q extends { kind: string }>(question: Q): question is Exclude<Q, { kind: "blind-ab" }> => question.kind !== "blind-ab";

const ContractRound = reviewSchema.RoundSchema.transform((manifest, ctx) => {
  const { questions } = manifest;
  if (questions.every(answeredHere)) return { ...manifest, questions };
  ctx.issues.push({ code: "custom", path: ["questions"], message: BLIND_AB_REFUSED, input: questions });
  return z.NEVER;
});

const Supersedes = z.array(z.string().regex(ROUND_ID, "a round id is a plain name")).min(1).max(MAX_SUPERSEDES);

export const RoundSchema = z.looseObject({ supersedes: Supersedes.optional(), planApprovals: PlanBindings.optional() }).transform(({ supersedes, planApprovals, ...rest }, ctx) => {
  const parsed = ContractRound.safeParse(rest);
  if (!parsed.success) {
    ctx.issues.push(...parsed.error.issues.map((issue) => ({ ...issue, input: undefined })));
    return z.NEVER;
  }
  const problems = planBindingProblems(planApprovals ?? [], parsed.data.questions);
  if (problems.length > 0) {
    ctx.issues.push(...problems.map((message) => ({ code: "custom" as const, path: ["planApprovals"], message, input: undefined })));
    return z.NEVER;
  }
  return { ...parsed.data, ...(supersedes !== undefined && { supersedes }), ...(planApprovals !== undefined && { planApprovals }) };
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
