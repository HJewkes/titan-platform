import type { WorkflowRun } from "@titan-design/workflow";
import { stepIdMatches } from "../definition.js";
import type { RegisterArgs } from "./register-args.js";
import type { ShepherdServices } from "./services.js";
import type { Registration } from "./store.js";
import { kindMoveRefusal, type KindMove } from "./task-kind.js";
import { testOnlyDiff } from "./test-only-diff.js";

/**
 * Read for every explicit move into test-only, whatever the stored kind: another register can change the kind between this read and
 * the store's transaction, so the guard gets diff facts even when the kind it sees is not the one read here.
 */
export async function kindMove(services: ShepherdServices, known: Registration, args: RegisterArgs, run: ReviewRead | undefined): Promise<KindMove> {
  const diff = args.kind === "test-only" ? await testOnlyDiff(services.port, args.repo, args.pr ?? known.pr, args.head ?? known.headSha ?? undefined) : undefined;
  const early = { reviewStarted: run && reviewStarted(run), reason: args.kindReason, actor: args.actor };
  return { guard: kindMoveRefusal, diff, early };
}

type ReviewRead = Pick<WorkflowRun, "stepResults" | "currentStep">;

/** The steps that brief, dispatch, ask for or await a reviewer; the fix-proof read before them reviews nothing. */
const REVIEW_STEPS = ["sh-review-intent", "sh-review", "sh-review-panel", "sh-review-request", "sh-await-verdict"];

/** True once any review step ran or is running, at any head of the run. */
export function reviewStarted(run: ReviewRead): boolean {
  const ids = [...Object.values(run.stepResults).map((result) => result.stepId), ...(run.currentStep === null ? [] : [run.currentStep])];
  return ids.some((id) => REVIEW_STEPS.some((step) => stepIdMatches(step, id)));
}

/** A mutation spec keeps a vacuous proof NO_REPRO (`proceedsOnNoRepro`), so a flake fix is steered away from adding one. */
export const TEST_ONLY_HINT =
  "hint: this PR changes only tests; re-register with --kind test-only. A flaky-test fix adds no <test>.mutations.json: with noReproProceed on, its vacuous fix-proof goes on to review, and any mutation spec keeps it NO_REPRO";

/** The hint reads the same diff facts the guard does, so it never suggests a move the register would refuse. */
export async function testOnlyHint(services: ShepherdServices, registration: Registration): Promise<string | undefined> {
  if (registration.kind !== "correctness" || registration.pr === null) return undefined;
  const diff = await testOnlyDiff(services.port, registration.repo, registration.pr, registration.headSha ?? undefined);
  return diff.kind === "test-only" ? TEST_ONLY_HINT : undefined;
}
