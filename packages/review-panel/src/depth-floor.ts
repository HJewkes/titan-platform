import type { NormalizedSessionObservation } from "@titan-design/session-read";

/** The closed set of read families that show a reviewer looked at the change: file reads and searches, and Bash read verbs. */
export const INVESTIGATIVE_CALLS = {
  tools: ["Read", "Grep", "Glob"],
  bashVerbs: ["git log", "git show", "git diff", "git grep", "gh pr view", "gh pr diff", "gh pr checks", "cat", "sed -n", "rg", "npx vitest", "grep", "head", "tail", "wc", "git ls-files", "git merge-tree", "pnpm exec vitest", "pnpm vitest", "npm run verify", "npm test", "node --test"],
} as const;

/** Why a parsed MERGE or FIX_FIRST was set aside: nothing in the reviewer's own session read the change first. */
export const DEPTH_FLOOR_REASON = "below the review depth floor: the reviewer made no investigative tool call before its verdict";

const startsWithVerb = (command: string, verb: string) => command === verb || command.startsWith(`${verb} `);

const HEREDOC_OPENER = /^<<-?\s*(?:"([^"]+)"|'([^']+)'|([^\s<>|&;()]+))/;

/** The index just past the body of the heredocs opened on this line, so body text is never read as commands. */
function skipHeredocBodies(command: string, from: number, delimiters: string[]): number {
  let index = from;
  for (const delimiter of delimiters) {
    while (index < command.length) {
      const end = command.indexOf("\n", index);
      const line = command.slice(index, end === -1 ? command.length : end);
      index = end === -1 ? command.length : end + 1;
      if (line.trim() === delimiter) break;
    }
  }
  return index;
}

/** Splits into pipelines at command positions: `&&`, `||`, `;` and newlines outside quotes and heredoc bodies. A single `|` stays inside its pipeline so a trailing filter cannot vouch for the command it reshapes. Not a full shell parser. */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  const delimiters: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string;
    const opener = quote === null && char === "<" && command[i + 1] === "<" && command[i + 2] !== "<" ? HEREDOC_OPENER.exec(command.slice(i)) : null;
    if (quote !== null) {
      if (char === quote) quote = null;
      current += char;
    } else if (opener !== null) {
      delimiters.push(opener[1] ?? opener[2] ?? opener[3] ?? "");
      current += opener[0];
      i += opener[0].length - 1;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ";" || char === "\n" || (char === "&" && command[i + 1] === "&") || (char === "|" && command[i + 1] === "|")) {
      segments.push(current);
      current = "";
      if (char === "\n") i = skipHeredocBodies(command, i + 1, delimiters.splice(0)) - 1;
      else if (char !== ";") i++;
    } else current += char;
  }
  segments.push(current);
  return segments;
}

const LEADING_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s*/;
const GIT_DIRECTORY_FLAG = /^git -C (?:"[^"]*"|'[^']*'|\S+) /;

/** The first command of a pipeline once leading `VAR=value` assignments and `git -C <dir>` are dropped. */
function effectiveCommand(segment: string): string {
  let rest = segment.trim();
  for (let match = LEADING_ASSIGNMENT.exec(rest); match !== null; match = LEADING_ASSIGNMENT.exec(rest)) rest = rest.slice(match[0].length);
  return rest.replace(GIT_DIRECTORY_FLAG, "git ");
}

const isReadSegment = (segment: string): boolean => {
  const command = effectiveCommand(segment);
  return INVESTIGATIVE_CALLS.bashVerbs.some((verb) => startsWithVerb(command, verb));
};

/** A Read, Grep or Glob call, or a Bash call in which some `&&`, `||`, `;` or newline separated pipeline starts with a read verb, made in this conversation rather than copied in. */
export function isInvestigativeCall(observation: NormalizedSessionObservation): boolean {
  if (observation.kind !== "tool_call" || observation.historyOrigin !== null) return false;
  if ((INVESTIGATIVE_CALLS.tools as readonly string[]).includes(observation.name)) return true;
  if (observation.name !== "Bash") return false;
  const command = (observation.input as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return false;
  return splitSegments(command).some(isReadSegment);
}
