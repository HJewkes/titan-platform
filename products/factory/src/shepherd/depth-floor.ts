import type { NormalizedSessionObservation } from "@titan-design/session-read";
import type { NoVerdictCause } from "./phases.js";

/** The closed set of read families that show a reviewer looked at the change: file reads and searches, and Bash read verbs. */
export const INVESTIGATIVE_CALLS = {
  tools: ["Read", "Grep", "Glob"],
  bashVerbs: ["git log", "git show", "git diff", "git grep", "gh pr view", "gh pr diff", "gh pr checks", "cat", "sed -n", "rg", "npx vitest", "grep", "ls", "head", "tail", "wc", "find", "git ls-files", "git merge-tree", "pnpm exec vitest", "pnpm vitest", "npm run verify", "npm test", "node --test"],
} as const;

/** Why a parsed MERGE or FIX_FIRST was set aside: nothing in the reviewer's own session read the change first. */
export const DEPTH_FLOOR_REASON = "below the review depth floor: the reviewer made no investigative tool call before its verdict";

const startsWithVerb = (command: string, verb: string) => command === verb || command.startsWith(`${verb} `);

/** Splits on `&&`, `||`, `;` and `|` outside single and double quotes; not a full shell parser. */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string;
    if (quote !== null) {
      if (char === quote) quote = null;
      current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ";" || char === "|" || (char === "&" && command[i + 1] === "&")) {
      segments.push(current);
      current = "";
      if (command[i + 1] === char) i++;
    } else current += char;
  }
  segments.push(current);
  return segments;
}

const LEADING_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s*/;
const GIT_DIRECTORY_FLAG = /^git -C (?:"[^"]*"|'[^']*'|\S+) /;

/** The command a segment runs once leading `VAR=value` assignments and `git -C <dir>` are dropped; a `cd` runs nothing worth counting. */
function effectiveCommand(segment: string): string {
  let rest = segment.trim();
  for (let match = LEADING_ASSIGNMENT.exec(rest); match !== null; match = LEADING_ASSIGNMENT.exec(rest)) rest = rest.slice(match[0].length);
  return rest.replace(GIT_DIRECTORY_FLAG, "git ");
}

const isReadSegment = (segment: string): boolean => {
  const command = effectiveCommand(segment);
  return !startsWithVerb(command, "cd") && INVESTIGATIVE_CALLS.bashVerbs.some((verb) => startsWithVerb(command, verb));
};

/** A Read, Grep or Glob call, or a Bash call in which some `&&`, `||`, `;` or `|` segment starts with a read verb, made in this conversation rather than copied in. */
export function isInvestigativeCall(observation: NormalizedSessionObservation): boolean {
  if (observation.kind !== "tool_call" || observation.historyOrigin !== null) return false;
  if ((INVESTIGATIVE_CALLS.tools as readonly string[]).includes(observation.name)) return true;
  if (observation.name !== "Bash") return false;
  const command = (observation.input as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return false;
  return splitSegments(command).some(isReadSegment);
}

/** A dispatched reviewer that wrote a verdict below the floor gave no verdict; any other silence is a timeout. */
export const dispatchedNoVerdictCause = (reason: unknown): NoVerdictCause => (reason === DEPTH_FLOOR_REASON ? "no-verdict" : "timeout");
