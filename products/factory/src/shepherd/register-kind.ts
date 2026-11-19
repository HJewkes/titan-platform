import type { RegisterArgs } from "./register-args.js";
import type { ShepherdServices } from "./services.js";
import type { Registration } from "./store.js";
import { FIX_PROOF_KINDS, kindMoveRefusal, type KindMove } from "./task-kind.js";
import { testOnlyDiff } from "./test-only-diff.js";
import { workflowOnlyDiff } from "./workflow-ci-proof.js";

/**
 * Read for every explicit move into test-only, whatever the stored kind: another register can change the kind between this read and
 * the store's transaction, so the guard gets diff facts even when the kind it sees is not the one read here.
 */
export async function kindMove(services: ShepherdServices, known: Registration, args: RegisterArgs): Promise<KindMove> {
  const diff = args.kind === "test-only" ? await testOnlyDiff(services.port, args.repo, args.pr ?? known.pr, args.head ?? known.headSha ?? undefined) : undefined;
  return { guard: kindMoveRefusal, diff };
}

/** A mutation spec keeps a vacuous proof NO_REPRO (`proceedsOnNoRepro`), so a flake fix is steered away from adding one. */
export const TEST_ONLY_HINT =
  "hint: this PR changes only tests; re-register with --kind test-only. A flaky-test fix adds no <test>.mutations.json: with noReproProceed on, its vacuous fix-proof goes on to review, and any mutation spec keeps it NO_REPRO";

/** The hint reads the same diff facts the guard does, so it never suggests a move the register would refuse. */
async function testOnlyHint(services: ShepherdServices, registration: Registration): Promise<string | undefined> {
  if (registration.kind !== "correctness" || registration.pr === null) return undefined;
  const diff = await testOnlyDiff(services.port, registration.repo, registration.pr, registration.headSha ?? undefined);
  return diff.kind === "test-only" ? TEST_ONLY_HINT : undefined;
}

export const WORKFLOW_ONLY_HINT =
  "hint: this PR changes only workflows; a workflow-ci fix-proof proves it only when a required check is red at the merge base, and is otherwise NO_REPRO. The kind cannot later leave the fix-proof kinds (correctness, security, test-only), so register such a PR with --kind feature or refactor on its first register";

/** The test-only hint wins on a tests-only diff; a workflow-only diff is never that, so the two never both apply. */
export async function kindHintFor(services: ShepherdServices, registration: Registration): Promise<string | undefined> {
  const testOnly = await testOnlyHint(services, registration);
  if (testOnly !== undefined) return testOnly;
  if (!FIX_PROOF_KINDS.has(registration.kind) || registration.pr === null) return undefined;
  return (await workflowOnlyDiff(services.port, registration.repo, registration.pr)) ? WORKFLOW_ONLY_HINT : undefined;
}
