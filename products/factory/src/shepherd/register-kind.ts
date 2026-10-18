import type { RegisterArgs } from "./register-args.js";
import type { ShepherdServices } from "./services.js";
import type { Registration } from "./store.js";
import { kindMoveRefusal } from "./task-kind.js";
import { testOnlyDiff, type TestOnlyDiff } from "./test-only-diff.js";

export type KindGuard = typeof kindMoveRefusal;

/** The guard a register applies, and the PR's diff facts it reads them with. */
export interface KindMove {
  guard: KindGuard;
  diff: TestOnlyDiff | undefined;
}

const guardOf = (services: ShepherdServices): KindGuard => services.kindGuard ?? kindMoveRefusal;

/**
 * Read for every explicit move into test-only, whatever the stored kind: another register can change the kind between this read and
 * the store's transaction, so the guard gets diff facts even when the kind it sees is not the one read here.
 */
export async function kindMove(services: ShepherdServices, known: Registration, args: RegisterArgs): Promise<KindMove> {
  const diff = args.kind === "test-only" ? await testOnlyDiff(services.port, args.repo, args.pr ?? known.pr) : undefined;
  return { guard: guardOf(services), diff };
}

const TESTS_ONLY: TestOnlyDiff = { kind: "test-only" };

export const TEST_ONLY_HINT =
  "hint: this PR changes only tests; re-register with --kind test-only and add a <test>.mutations.json sidecar, or fix-proof reads it as NO_REPRO";

/** Only once the guard would accept the move does the hint read GitHub, so it never suggests a kind the register would refuse. */
export async function testOnlyHint(services: ShepherdServices, registration: Registration): Promise<string | undefined> {
  if (registration.kind !== "correctness" || registration.pr === null) return undefined;
  if (guardOf(services)("correctness", "test-only", TESTS_ONLY) !== undefined) return undefined;
  const diff = await testOnlyDiff(services.port, registration.repo, registration.pr);
  return diff.kind === "test-only" ? TEST_ONLY_HINT : undefined;
}
