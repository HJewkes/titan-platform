const CLASSIFIER_DENIAL = /classifier\. Reason/i;
const PERMISSION_DENIAL = /Permission to use .* (has been )?denied|permission.*denied by|was denied/is;

/** The self-improve extractor's error classes in match order: first hit wins, so a classifier denial is never "permission-denied". */
const CLASS_PATTERNS = [
  ["classifier-denial", CLASSIFIER_DENIAL],
  ["permission-denied", PERMISSION_DENIAL],
  ["user-rejected", /doesn't want to proceed|user rejected|The user doesn't want/i],
  ["sleep-block", /Blocked: sleep|sleep .* is blocked/i],
  ["wrong-tool-name", /No such tool available/i],
  ["hook-block", /hook (error|blocked)|PreToolUse.*(blocked|denied)|Blocked: /i],
  ["edit-not-read", /File has not been read yet|must Read the file/i],
  ["edit-no-match", /String to replace not found|old_string.*not found|not unique/i],
  ["file-missing", /No such file or directory|File does not exist|ENOENT/i],
  ["gh-graphql-ratelimit", /GraphQL: API rate limit/i],
  ["gh-secondary-ratelimit", /secondary rate limit/i],
  ["gh-other", /gh: |HTTP 4\d\d|HTTP 5\d\d/i],
  ["git-error", /fatal: |error: (failed to push|pathspec|Your local changes)|non-fast-forward|CONFLICT/i],
  ["timeout", /timed out|Command timed out|ETIMEDOUT/i],
  ["mcp-tool-error", /InputValidationError|Invalid input|MCP error/i],
  ["agent-chat-refused", /no active session named|spawn failed|no free agent slots|refused/i],
  ["test-fail", /(\d+ failed|FAIL |Tests? failed|AssertionError)/i],
  ["lint-type", /error TS\d+|eslint|✖ \d+ problems/i],
  ["exit-code", /Exit code \d+/i],
] as const satisfies readonly (readonly [string, RegExp])[];

/** `unreadable` is an error whose transcript line is gone or moved, so its text cannot be classed. */
export const ERROR_CLASSES = [...CLASS_PATTERNS.map(([name]) => name), "other", "unreadable"] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

/** Insights Q5's classifier for a tool result's text. */
export function classifyError(text: string): ErrorClass {
  return CLASS_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? "other";
}

export interface Denial {
  kind: "classifier" | "permission" | "hook-deadline";
  /** The classifier's bracketed reason, when the text carries one. */
  reason?: string;
}

const CLASSIFIER_REFUSAL = /denied by the Claude Code auto mode classifier/;
const CLASSIFIER_REASON = /classifier\. Reason: \[([^\]]+)\]/;
const HOOK_DEADLINE = /permission-hook deadline/;

/** The one reading of Claude Code's refusal text: classifier denial, permission deny-list, or permission-hook deadline; null for any other text. */
export function denialOf(text: string): Denial | null {
  if (CLASSIFIER_DENIAL.test(text) || CLASSIFIER_REFUSAL.test(text)) {
    const reason = CLASSIFIER_REASON.exec(text)?.[1];
    return reason === undefined ? { kind: "classifier" } : { kind: "classifier", reason };
  }
  if (PERMISSION_DENIAL.test(text)) return { kind: "permission" };
  return HOOK_DEADLINE.test(text) ? { kind: "hook-deadline" } : null;
}
