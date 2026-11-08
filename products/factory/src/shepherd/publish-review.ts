import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { consoleTextOf, failureOf } from "./error-class.js";
import type { ObservedPr } from "./observe.js";
import type { ShepherdDeps, Verdict } from "./phases.js";
import { approveOnSuccess, type ReviewApproval } from "./review-approval.js";
import { dismissStale, type ReviewDismissal } from "./review-dismissal.js";
import { reviewCheck, type ReviewCheckInput, type ReviewConclusion } from "./review-check.js";
import { REVIEW_OUTCOMES, type ReviewOutcome } from "./route-table.js";

const PUBLISH_REVIEW_STEP = "sh-publish-review";
export const REVIEW_CHECK_NAME = "shepherd/review";
export const PUBLISH_REVIEW_STEPS: readonly StepDeclaration[] = [{ id: PUBLISH_REVIEW_STEP, kind: "dispatch" }];

const PublishInputSchema = z.strictObject({
  repo: z.string().min(1),
  pr: z.number().int().positive(),
  runId: z.string().min(1),
  outcome: z.enum(REVIEW_OUTCOMES),
  verdictHead: z.string().min(1).optional(),
  head: z.string().min(1),
  carriedFrom: z.string().min(1).optional(),
  carryRule: z.enum(["tree-equal", "remerge-empty", "remerge-generated-only"]).optional(),
  releaseBlockers: z.number().int().min(0).optional(),
  attestUnmet: z.array(z.string().min(1)).optional(),
});

type PublishInput = z.infer<typeof PublishInputSchema>;

/** Where the armed flag is read, so the mapper guard sees what GitHub says at publish time. */
type ArmedReader = Pick<GitHubPort, "getPr">;

type PublishedReview = ReviewApproval | ReviewDismissal;

type PublishResult = { headSha: string; conclusion: ReviewConclusion; review?: PublishedReview } & PostedCheck;

type PostedCheck = ({ published: true; checkRunId: number; checkRunUrl: string } | { published: false; reason: string });

const PublishedResult = z.looseObject({ published: z.boolean() });

type PrTarget = { repo: RepoSlug; pr: number };

/**
 * Posts at `check.head`, so a moved head is published at the new head; the step never fails the run. A replay whose record
 * went on without this publish skips it: the record is older than the step, and the run has since left that review.
 */
export async function publishReview(ctx: WorkflowContext, target: PrTarget, check: Omit<ReviewCheckInput, "autoMergeArmed">, suffix = ""): Promise<void> {
  const next = ctx.historyNext();
  if (next !== undefined && !next.startsWith(`${PUBLISH_REVIEW_STEP}:`)) return;
  const input = { repo: target.repo, pr: target.pr, runId: ctx.runId, ...check };
  await step(ctx, `${PUBLISH_REVIEW_STEP}:${check.head}${suffix}`, input, PublishedResult);
}

/**
 * What the review of `headSha` came to, read after the review ends. Every outcome but MERGE and carried is published here, a moved
 * head at the head the PR moved to; a MERGE was published by `mergeVerdict`, before its evidence step.
 */
export async function publishOutcome(ctx: WorkflowContext, target: PrTarget, verdict: Verdict, observed: ObservedPr, headSha: string): Promise<ReviewOutcome> {
  const outcome = reviewOutcome(verdict, observed, headSha);
  if (outcome !== "MERGE" && outcome !== "carried") await publishReview(ctx, target, { outcome, verdictHead: headSha, head: outcome === "head-moved" ? observed.headSha : headSha });
  return outcome;
}

function reviewOutcome(verdict: Verdict, observed: ObservedPr, headSha: string): ReviewOutcome {
  if (observed.headSha !== headSha) return "head-moved";
  if (verdict.kind === "MERGE") return "MERGE";
  if (verdict.kind === "none") return verdict.cause ?? "no-verdict";
  return "FIX_FIRST";
}

export const publishReviewRoute = (deps: ShepherdDeps): StepRoute =>
  codeRoute(PUBLISH_REVIEW_STEP, deps.now, async (raw: unknown) => publish(deps.reviewCheck, deps.port, PublishInputSchema.parse(raw)));

/** The check run, then the APPROVE review at the same head on a success or the dismissal of older ones otherwise; no failure fails the step. */
async function publish(port: GitHubPort | undefined, reads: ArmedReader, input: PublishInput): Promise<PublishResult> {
  const check = reviewCheck({ ...input, autoMergeArmed: await autoMergeArmed(reads, input) });
  const posted = await postCheck(port, input, check);
  const review = check.conclusion === "success" ? await approveOnSuccess(port, input, check) : await dismissStale(port, input, check);
  return { ...posted, ...(review && { review }) };
}

/** Each publish is a new run, and GitHub keeps the newest per name and App, so a repeat after a crash is harmless. */
async function postCheck(port: GitHubPort | undefined, input: PublishInput, check: ReturnType<typeof reviewCheck>): Promise<PublishResult> {
  const posted = { headSha: check.headSha, conclusion: check.conclusion };
  if (!port) return { ...posted, published: false, reason: "no shepherd.reviewCheck App is configured" };
  try {
    const { id } = await port.createCheckRun(input.repo, { name: REVIEW_CHECK_NAME, ...check, externalId: input.runId });
    return { ...posted, published: true, checkRunId: id, checkRunUrl: `https://github.com/${input.repo}/runs/${id}` };
  } catch (error) {
    // The stored reason can reach a public PR, so the message goes to the local console only.
    console.warn(`shepherd: publishing ${REVIEW_CHECK_NAME} at ${check.headSha} failed: ${consoleTextOf(error)}`);
    return { ...posted, published: false, reason: `the check run post failed: ${failureOf(error)}` };
  }
}

/** An unreadable PR counts as armed: the check then holds the merge instead of vouching for a PR it could not see. */
async function autoMergeArmed(reads: ArmedReader, input: PublishInput): Promise<boolean> {
  try {
    return (await reads.getPr(input.repo, input.pr)).autoMerge;
  } catch (error) {
    console.warn(`shepherd: reading auto-merge of ${input.repo}#${input.pr} failed: ${consoleTextOf(error)}`);
    return true;
  }
}
