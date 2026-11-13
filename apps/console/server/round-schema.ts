/**
 * The console's one round.json schema: review-schema's strict `RoundSchema`, with the console's own fields lifted off.
 *
 * A blind-ab round is refused. Its takes name their engines, the page must never see them, and the console
 * keeps no blind key, so the review harness answers those rounds. Feedback with a blind-ab answer (`pairs`,
 * whose `engine` the harness fills in after the send) is refused for the same reason.
 *
 * `supersedes` (TP-3990) is the console's own field, not review-schema's: the ids of earlier rounds this one replaces,
 * which `round-supersede.ts` withdraws while they are still open. It is lifted off before the strict parse, since
 * review-schema does not know it. `planApprovals` (TP-4357) is lifted the same
 * way: the plan-approval entries a plan round's answer records (`round-plan-binding.ts`). `kind` (TP-5409) is lifted too:
 * `feedback` marks a post-merge visual sheet, which shows what changed and asks for notes, so it may bind no merge.
 */
import { z } from "zod";
import * as reviewSchema from "@titan-design/review-schema";
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

const RoundKind = z.enum(["feedback"]);
type RoundKind = z.infer<typeof RoundKind>;

export const FEEDBACK_MERGE_REFUSED = "a feedback round asks nothing that merges: drop the merge binding";

/** A post-merge feedback sheet (TP-5409) shows what already merged, so no question in it may bind a merge. */
function feedbackProblems(kind: RoundKind | undefined, questions: readonly { id: string; kind: string; merge?: unknown }[]): string[] {
  if (kind !== "feedback") return [];
  return questions.filter((question) => question.kind === "pick-one" && question.merge !== undefined).map((question) => `question ${question.id}: ${FEEDBACK_MERGE_REFUSED}`);
}

const ConsoleFields = z.looseObject({ supersedes: Supersedes.optional(), planApprovals: PlanBindings.optional(), kind: RoundKind.optional() });

export const RoundSchema = ConsoleFields.transform(({ supersedes, planApprovals, kind, ...rest }, ctx) => {
  const parsed = ContractRound.safeParse(rest);
  if (!parsed.success) {
    ctx.issues.push(...parsed.error.issues.map((issue) => ({ ...issue, input: undefined })));
    return z.NEVER;
  }
  const bindings = planBindingProblems(planApprovals ?? [], parsed.data.questions).map((message) => ({ path: "planApprovals", message }));
  const problems = [...bindings, ...feedbackProblems(kind, parsed.data.questions).map((message) => ({ path: "questions", message }))];
  if (problems.length > 0) {
    ctx.issues.push(...problems.map(({ path, message }) => ({ code: "custom" as const, path: [path], message, input: undefined })));
    return z.NEVER;
  }
  return { ...parsed.data, ...(supersedes !== undefined && { supersedes }), ...(planApprovals !== undefined && { planApprovals }), ...(kind !== undefined && { kind }) };
});

const notBlindAb = (answer: { pairs?: unknown }): boolean => answer.pairs === undefined;

export const FeedbackSchema = reviewSchema.FeedbackSchema.refine((feedback) => feedback.answers.every(notBlindAb), {
  path: ["answers"],
  message: BLIND_AB_REFUSED,
});

export type Feedback = z.output<typeof FeedbackSchema>;
export type Manifest = z.output<typeof RoundSchema>;

export type ReviewManifest = Omit<Manifest, "supersedes" | "planApprovals" | "kind">;

/** The manifest as review-schema reads it: its strict parse refuses the console's own fields, so they come off. */
export function reviewManifest({ supersedes: _supersedes, planApprovals: _planApprovals, kind: _kind, ...manifest }: Manifest): ReviewManifest {
  return manifest;
}
export type Question = Manifest["questions"][number];
export type Section = reviewSchema.Section;
