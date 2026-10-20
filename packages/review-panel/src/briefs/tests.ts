import { TEST_CLASSES, parseResultLine, provedByMutants, type FixProofResult, type Verdict } from "@titan-design/fix-proof";

export const TESTS_OVERLAY: readonly string[] = [
  "You are the tests member of a review panel. Other members judge correctness and scope; your question is whether the tests prove the change.",
  "Would each added test fail on the base? Does it assert behavior a caller sees rather than implementation details? Does the change's error path have a test?",
  "Say FIX_FIRST when no test would fail without the change, or when a test asserts nothing the change does.",
];

/** What the reviewer is told to do with each verdict; a closed map, so only code-chosen text reaches the prompt. */
const VERDICT_READING: Record<Verdict, string> = {
  reproduced: "At least one added test fails on the base and passes at head. Check that it asserts the behavior the PR claims.",
  unproven: "The added tests fail on the base only because the API they call is new there. Judge whether a test of the behavior itself was possible.",
  vacuous: "No added test fails on the base, so none proves the change. That is blocking unless you show why no test can fail there.",
  "no-tests": "The change adds or edits no test. That is blocking unless you show why no test can fail on the base.",
  error: "fix-proof could not finish, so nothing proves the change. That is blocking unless you name an added test and show it fails on the base.",
};

const MUTANTS_READING =
  "The PR changes only tests, so base and head run the same code; instead every changed test file has a mutation spec in this diff, every mutation its specs declare made the tests it names fail, and the tests pass at head. Check that each mutation is a bug a caller would see and that the tests it kills are the ones the PR changed.";

function verdictLine(result: FixProofResult): string {
  const reading = provedByMutants(result) ? MUTANTS_READING : VERDICT_READING[result.verdict];
  return `fix-proof/v1 verdict for this head: ${result.verdict}. ${reading}`;
}

/** Why Shepherd could not verify this head's fix-proof; a head can force each of these, so none may pass on its own. */
export type FixProofUnverified = "error" | "untrusted" | "unread" | "no-repro-test-only";

/** A closed map, so the caller's reason picks a sentence and never reaches the prompt itself. */
const UNVERIFIED_READING: Record<FixProofUnverified, string> = {
  error: "Shepherd marks this head's fix-proof unverified: the run ended in an error, which a head can cause on purpose.",
  untrusted: "Shepherd marks this head's fix-proof unverified: its run did not come from a trusted, successful fix-proof job, so its result is not evidence.",
  unread: "Shepherd marks this head's fix-proof unverified: it could not read a fix-proof result for this head although one was due.",
  "no-repro-test-only": "Shepherd marks this head's fix-proof unverified: the PR changes only tests, so its proof found no test that fails on the base, and the review goes ahead.",
};

const UNVERIFIED_RULE = "Say FIX_FIRST unless you name an added test and show it fails on the base; a MERGE here merges on green with the unverified standing recorded.";

const TEST_ONLY_RULE = "Judge each added test on its own: say FIX_FIRST unless it asserts behavior the code has; a MERGE here merges on green with the unverified standing recorded.";

const JUDGE_YOURSELF = "Read each added test against the base code and say which would fail there.";

function countLine(result: FixProofResult): string {
  return `Test counts: ${TEST_CLASSES.map((name) => `${name} ${result.counts[name]}`).join(", ")}.`;
}

/** Only counts and flags are read: test names and paths are text the implementer wrote, so none reaches the prompt. */
function cautionLines(result: FixProofResult): string[] {
  const lines: string[] = [];
  if (result.deletedTests.length > 0) lines.push(`The PR deletes ${result.deletedTests.length} test file(s); check that each covered nothing still live.`);
  if (result.notCollected.length > 0) lines.push(`${result.notCollected.length} selected test file(s) were not collected; read them as unproven.`);
  if (result.configEdited) lines.push("The PR edits the fix-proof config, which changes which tests count; read that edit as a claim to check.");
  if (result.truncated) lines.push("The result was truncated to fit its line, so its lists are incomplete.");
  return lines;
}

/** The tests member's fix-proof section; a result that does not parse or names another head is ignored, never trusted. */
export function fixProofLines(head: string, line: string | undefined): string[] {
  if (line === undefined) return [`No fix-proof/v1 result was given for this head. ${JUDGE_YOURSELF}`];
  const parsed = parseResultLine(line.trim());
  if (!parsed.ok) return [`The fix-proof/v1 result given could not be read, so ignore it. ${JUDGE_YOURSELF}`];
  const { result } = parsed;
  if (result.head !== head) return [`The fix-proof/v1 result given is for another head, so ignore it. ${JUDGE_YOURSELF}`];
  return [verdictLine(result), countLine(result), ...cautionLines(result)];
}

const WAIVED_READING =
  "Shepherd: fix-proof waived by owner at this head. Do not count a missing, vacuous or failed fix-proof against this PR, and do not ask for one; judge the tests on their own merits.";

/** The owner's waiver, which replaces the fix-proof reading; one recorded at any other head, as before a merge-up, yields nothing. */
export function waivedLines(head: string, waivedAt: string | undefined): string[] {
  return waivedAt === head ? [WAIVED_READING] : [];
}

/** The unverified section; an unknown reason, as from stored JSON, yields nothing rather than echoing it. */
export function unverifiedLines(why: FixProofUnverified | undefined): string[] {
  const reading = why === undefined || !Object.hasOwn(UNVERIFIED_READING, why) ? undefined : UNVERIFIED_READING[why];
  return reading === undefined ? [] : [reading, why === "no-repro-test-only" ? TEST_ONLY_RULE : UNVERIFIED_RULE];
}
