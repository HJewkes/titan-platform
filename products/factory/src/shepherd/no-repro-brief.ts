/**
 * The only two NO_REPRO verdicts, each in fixed words so no result text reaches `reason`. Each says only what the
 * verdict guarantees: `vacuous` covers a test that passes on base, fails at head or never ran, so which one stays in the fenced result.
 */
export const NO_REPRO_REASON: Readonly<Record<string, string>> = {
  vacuous: "no test the proof ran fails at the merge base and passes at the head; each test's class is in the fenced result",
  "no-tests": "no test added: the PR adds or changes no test file the proof could run",
};
/** A test-only diff with a mutation check cannot fail on the base, so its send-back asks for kills instead. */
export const MUTANTS_REASON =
  "the PR changes only tests, and the mutation check did not pass: a changed test file has no mutation spec of its own in this diff, some declared mutation survived, a test failed or did not run at the head, or the mutants could not be judged; each mutation's outcome is in the fenced result";
export const MUTANTS_ASK =
  "On the head branch named in the fence below, give every changed test file a `<test>.mutations.json` beside it (the files still missing one are fenced below), make the tests each mutation's kills name fail under that mutation and pass at the head, or correct the spec; support files they need must match the carry globs below.";
export const UNCOVERED_LABEL = "changed test files with no mutation spec";
export const REPRO_ASK =
  "Add or change a test on the head branch named in the fence below that fails at the merge base and passes at the head; support files it needs must match the carry globs below, or the proof will not copy them to the merge-base side.";
/** `proceedsOnNoRepro` lets only a spec-free test-only PR past a vacuous proof, so a flake fix must not add a spec. */
export const FLAKE_FIX_ASK =
  "A flaky-test fix that changes only tests needs no base-failing test and no mutation spec: register it with `--kind test-only` and leave out any `*.mutations.json`, since with noReproProceed on a test-only PR's vacuous proof goes on to review, and a mutation spec keeps it NO_REPRO.";
export const CARRY_UNREADABLE = "The carry globs could not be read at the merge base, so the error follows in their place.";
