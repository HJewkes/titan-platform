import type { PlannerInput } from "./config.js";

/**
 * Measured on the planner's own recorded inputs (TP-3911 A/B): ~219k characters of tool output came to ~222k Opus
 * tokens, so a character is budgeted as a token rather than the usual four-to-one.
 */
const CHARS_PER_TOKEN = 1;

export interface DigestPiece {
  input: PlannerInput;
  text: string;
}

/** The digest inputs in config order, each cut to its tail, then the whole cut to the token budget with a marker. */
export function buildDigest(pieces: readonly DigestPiece[], maxTokens: number): string {
  const body = pieces
    .filter(({ input }) => input.digest)
    .map(({ input, text }) => `## ${input.name}\n\n${tailOf(text, input.tailLines)}\n`)
    .join("\n");
  const budget = maxTokens * CHARS_PER_TOKEN;
  if (body.length <= budget) return body;
  const marker = `\n[digest cut at ${maxTokens} tokens; read the source file for the rest]\n`;
  return body.slice(0, Math.max(0, budget - marker.length)) + marker;
}

function tailOf(text: string, lines: number | undefined): string {
  if (lines === undefined) return text.trimEnd();
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

export function digestPreamble(path: string, maxTokens: number): string {
  return `Your inputs are pre-digested (at most ${maxTokens} tokens) in ${path}. Read it first, and open a source file only for what it leaves out.\n\n`;
}
