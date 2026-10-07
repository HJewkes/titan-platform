import type { NormalizedSessionObservation } from "@titan-design/session-read";

/** The closed set of read families that show a reviewer looked at the change: file reads and searches, and Bash read verbs. */
export const INVESTIGATIVE_CALLS = {
  tools: ["Read", "Grep", "Glob"],
  bashVerbs: ["git log", "git show", "git diff", "git grep", "gh pr view", "gh pr diff", "gh pr checks", "cat", "sed -n", "rg", "npx vitest"],
} as const;

/** Why a parsed MERGE or FIX_FIRST was set aside: nothing in the reviewer's own session read the change first. */
export const DEPTH_FLOOR_REASON = "below the review depth floor: the reviewer made no investigative tool call before its verdict";

const startsWithVerb = (command: string, verb: string) => command === verb || command.startsWith(`${verb} `);

/** A Read, Grep or Glob call, or a Bash call whose command starts with a read verb, made in this conversation rather than copied in. */
export function isInvestigativeCall(observation: NormalizedSessionObservation): boolean {
  if (observation.kind !== "tool_call" || observation.historyOrigin !== null) return false;
  if ((INVESTIGATIVE_CALLS.tools as readonly string[]).includes(observation.name)) return true;
  if (observation.name !== "Bash") return false;
  const command = (observation.input as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return false;
  const trimmed = command.trimStart();
  return INVESTIGATIVE_CALLS.bashVerbs.some((verb) => startsWithVerb(trimmed, verb));
}
