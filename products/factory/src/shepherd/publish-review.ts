import { readFile } from "node:fs/promises";
import { appInstallationToken, ghCliWire, githubPort, type GitHubPort, type RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { ReviewCheckConfig } from "../config.js";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { consoleTextOf, failureOf } from "./error-class.js";
import type { ObservedPr } from "./observe.js";
import type { ShepherdDeps, Verdict } from "./phases.js";
import { reviewCheck, type ReviewCheckInput, type ReviewConclusion } from "./review-check.js";
import { REVIEW_OUTCOMES, type ReviewOutcome } from "./route-table.js";

const PUBLISH_REVIEW_STEP = "sh-publish-review";
export const REVIEW_CHECK_NAME = "shepherd/review";
export const PUBLISH_REVIEW_STEPS: readonly StepDeclaration[] = [{ id: PUBLISH_REVIEW_STEP, kind: "dispatch" }];

/** The port does not read GitHub's `auto_merge`, and Shepherd never arms it, so every publish passes this until the port reads it. */
const AUTO_MERGE_UNREAD = false;

const PublishInputSchema = z.strictObject({
  repo: z.string().min(1),
  pr: z.number().int().positive(),
  runId: z.string().min(1),
  outcome: z.enum(REVIEW_OUTCOMES),
  verdictHead: z.string().min(1).optional(),
  head: z.string().min(1),
  autoMergeArmed: z.boolean(),
  releaseBlockers: z.number().int().min(0).optional(),
});

type PublishInput = z.infer<typeof PublishInputSchema>;

type PublishResult = { headSha: string; conclusion: ReviewConclusion } & ({ published: true; checkRunId: number; checkRunUrl: string } | { published: false; reason: string });

const PublishedResult = z.looseObject({ published: z.boolean() });

type PrTarget = { repo: RepoSlug; pr: number };

/** Posts at `check.head`, so a moved head is published at the new head; the step never fails the run. */
export async function publishReview(ctx: WorkflowContext, target: PrTarget, check: Omit<ReviewCheckInput, "autoMergeArmed">): Promise<void> {
  const input = { repo: target.repo, pr: target.pr, runId: ctx.runId, ...check, autoMergeArmed: AUTO_MERGE_UNREAD };
  await step(ctx, `${PUBLISH_REVIEW_STEP}:${check.head}`, input, PublishedResult);
}

/**
 * What the review of `headSha` came to, read after the review ends. Every outcome but MERGE is published here, a moved
 * head at the head the PR moved to; a MERGE was published where it was taken, before its evidence step.
 */
export async function publishOutcome(ctx: WorkflowContext, target: PrTarget, verdict: Verdict, observed: ObservedPr, headSha: string): Promise<ReviewOutcome> {
  const outcome = reviewOutcome(verdict, observed, headSha);
  if (outcome !== "MERGE") await publishReview(ctx, target, { outcome, verdictHead: headSha, head: outcome === "head-moved" ? observed.headSha : headSha });
  return outcome;
}

function reviewOutcome(verdict: Verdict, observed: ObservedPr, headSha: string): ReviewOutcome {
  if (observed.headSha !== headSha) return "head-moved";
  if (verdict.kind === "MERGE") return "MERGE";
  if (verdict.kind === "none") return verdict.cause ?? "no-verdict";
  return "FIX_FIRST";
}

export const publishReviewRoute = (deps: ShepherdDeps): StepRoute =>
  codeRoute(PUBLISH_REVIEW_STEP, deps.now, async (raw: unknown) => publish(deps.reviewCheck, PublishInputSchema.parse(raw)));

/** Each publish is a new run, and GitHub keeps the newest per name and App, so a repeat after a crash is harmless. */
async function publish(port: GitHubPort | undefined, input: PublishInput): Promise<PublishResult> {
  const check = reviewCheck(input);
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

/** The App-token port the publish step posts through; the key is read per post, so a missing file fails that post only. */
export function reviewCheckPort(config: ReviewCheckConfig | undefined): GitHubPort | undefined {
  if (!config) return undefined;
  const appToken = async (): Promise<string> => {
    const privateKeyPem = await readFile(config.privateKeyPath, "utf8");
    return (await appInstallationToken({ appId: config.appId, installationId: config.installationId, privateKeyPem, now: Date.now })).token;
  };
  return githubPort(ghCliWire(undefined, { appToken }));
}
