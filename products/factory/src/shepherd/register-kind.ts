import type { GitHubPort } from "@titan-design/github";
import type { RegisterArgs } from "./register-args.js";
import type { Registration } from "./store.js";
import { kindMoveRefusal } from "./task-kind.js";
import { testOnlyDiff, type TestOnlyDiff } from "./test-only-diff.js";

/**
 * Read for every explicit move into test-only, whatever the stored kind: another register can change the kind between this read and
 * the store's transaction, so the guard gets diff facts even when the kind it sees is not the one read here.
 */
export async function moveDiff(port: GitHubPort, known: Registration, args: RegisterArgs): Promise<TestOnlyDiff | undefined> {
  if (args.kind !== "test-only") return undefined;
  return testOnlyDiff(port, args.repo, args.pr ?? known.pr);
}

const TESTS_ONLY: TestOnlyDiff = { kind: "test-only" };

export const TEST_ONLY_HINT =
  "hint: this PR changes only tests; re-register with --kind test-only and add a <test>.mutations.json sidecar, or fix-proof reads it as NO_REPRO";

/** Only once the guard would accept the move does the hint read GitHub, so it never suggests a kind the register would refuse. */
export async function testOnlyHint(port: GitHubPort, registration: Registration): Promise<string | undefined> {
  if (registration.kind !== "correctness" || registration.pr === null) return undefined;
  if (kindMoveRefusal("correctness", "test-only", TESTS_ONLY) !== undefined) return undefined;
  const diff = await testOnlyDiff(port, registration.repo, registration.pr);
  return diff.kind === "test-only" ? TEST_ONLY_HINT : undefined;
}
