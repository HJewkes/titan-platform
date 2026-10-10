import { TEST_CLASSES, parseResultLine, type FixProofResult, type Verdict } from "@titan-design/fix-proof";

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
  error: "fix-proof could not finish. Judge base failure yourself, as if no result were given.",
};

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
  const parsed = parseResultLine(line);
  if (!parsed.ok) return [`The fix-proof/v1 result given could not be read, so ignore it. ${JUDGE_YOURSELF}`];
  const { result } = parsed;
  if (result.head !== head) return [`The fix-proof/v1 result given is for another head, so ignore it. ${JUDGE_YOURSELF}`];
  return [`fix-proof/v1 verdict for this head: ${result.verdict}. ${VERDICT_READING[result.verdict]}`, countLine(result), ...cautionLines(result)];
}
