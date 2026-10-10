import type { RepoSlug } from "@titan-design/github";
import { EXIT, defineCommand } from "@titan-design/registry";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import type { FactoryContext } from "../registry.js";
import { codeRoute, step } from "../workflows/land.js";
import type { ShepherdServices } from "./commands.js";
import type { ShepherdDeps, Verdict } from "./phases.js";
import type { CauseTrail } from "./review-cause.js";
import { VERSION_PACKAGES_BRANCH } from "./release.js";
import { FINISHED_RUN_STATUSES } from "./run-status.js";
import { isRepoKey } from "./seats.js";
import type { Registration } from "./store.js";

/** Reads whether `shepherd review` asked for Shepherd's own review at a head the run already took a verdict at. */
const REVIEW_REQUEST_STEP = "sh-review-request";
export const REVIEW_REQUEST_STEPS: readonly StepDeclaration[] = [{ id: REVIEW_REQUEST_STEP, kind: "dispatch" }];

/** True while `shepherd review` asked for Shepherd's own review at `head` and no review intent has taken the ask yet. */
export const reviewPendingAt = (registration: Registration | undefined, head: string): boolean => registration?.reviewRequest?.head === head && registration.reviewRequest.takenAt === null;

const RequestRead = z.looseObject({ requested: z.boolean() });

/** A replay whose record took another step here ran before the verb existed, so it keeps the verdict it had. */
function recordedElsewhere(ctx: WorkflowContext, stepId: string): boolean {
  const next = ctx.historyNext();
  return next !== undefined && next !== stepId;
}

async function reviewRequested(ctx: WorkflowContext, head: string): Promise<boolean> {
  const stepId = `${REVIEW_REQUEST_STEP}:${head}`;
  if (recordedElsewhere(ctx, stepId)) return false;
  return (await step(ctx, stepId, { runId: ctx.runId, head }, RequestRead)).requested;
}

interface ReviewedRun {
  ctx: WorkflowContext;
  release: boolean;
  reviews: Map<string, Verdict>;
  trail: CauseTrail;
}

/**
 * The verdict the run already took at `headSha`, unless a seat's untaken ask stands there: then the verdict is set aside and
 * the trail marks the head, so its next review is Shepherd's own and never a carry.
 */
export async function standingVerdict(run: ReviewedRun, headSha: string): Promise<Verdict | undefined> {
  const verdict = run.reviews.get(headSha);
  if (verdict === undefined || run.release || !(await reviewRequested(run.ctx, headSha))) return verdict;
  run.reviews.delete(headSha);
  run.trail.seatAsked.add(headSha);
  return undefined;
}

export const reviewRequestRoute = (deps: Pick<ShepherdDeps, "store" | "now">): StepRoute =>
  codeRoute(REVIEW_REQUEST_STEP, deps.now, async (input: { runId: string; head: string }) => ({ requested: reviewPendingAt(deps.store.get().byRun(input.runId), input.head) }));

export interface ReviewAsk {
  runId: string;
  /** The PR head read when the ask was made; the run reviews this head only. */
  head: string;
  /** False when an ask at this head already stood, taken or not, so nothing new was asked. */
  requested: boolean;
}

const refused = (message: string, code: number): Error => Object.assign(new Error(message), { code });

/** Only a registered PR's run can take an ask, and a finished or release run reads none, so each is refused before anything is recorded. */
async function askReview({ repo, pr }: { repo: RepoSlug; pr: number }, ctx: FactoryContext): Promise<ReviewAsk> {
  const services: ShepherdServices | undefined = ctx.shepherd;
  if (!services) throw refused("shepherd commands need the shepherd routes, and this host was opened without them", EXIT.UNAVAILABLE);
  const registration = services.store.get().byPr(repo, pr);
  if (!registration) throw refused(`${repo}#${pr} is not registered with shepherd`, EXIT.NOINPUT);
  const run = ctx.host.runtime.status(registration.runId);
  if (run === undefined || FINISHED_RUN_STATUSES.has(run.status)) throw refused(`shepherd run ${registration.runId} already ended (${run?.status ?? "missing"}), so no review was asked`, EXIT.DATAERR);
  if (run.params.branch === VERSION_PACKAGES_BRANCH) throw refused(`shepherd run ${run.id} lands the Version Packages PR, whose release preflight stands in for a reviewer, so no review was asked`, EXIT.DATAERR);
  const { headSha } = await services.port.getPr(repo, pr);
  return { runId: registration.runId, head: headSha, requested: services.store.get().requestReview(registration.runId, headSha) };
}

export const reviewCommand = defineCommand<{ repo: RepoSlug; pr: number }, ReviewAsk, FactoryContext>({
  name: "shepherd.review",
  description: "Ask for Shepherd's own fresh review of owner/repo#pr at its current head, set beside any verdict the run already took there; a repeat at the same head asks nothing",
  args: z.object({ repo: z.string().refine(isRepoKey, "must be owner/repo"), pr: z.number().int().positive() }),
  result: z.custom<ReviewAsk>(),
  run: askReview,
});
