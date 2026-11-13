import { labelledLineRest, parseVerdictBlock, visibleLines } from "@titan-design/session-read";
import { AUTHORITY_HEADING, PROBES_HEADING } from "./briefs/adversary.js";
import { ATTESTS_HEADING } from "./briefs/attest.js";
import { FOLLOW_UPS_HEADING } from "./follow-ups.js";
import type { ReviewerMessage } from "./ports.js";

/** A cleanup note is one short sentence; a longer preface is a review in its own right, never a repeat. */
const BARE_PREFACE_CHARS = 200;
/** The only prose a bare repeat may carry: the reviewer saying it removed its checkout. */
const CLEANUP_NOTE = /\b(?:remov|delet|clean)\w*\b.*\b(?:checkouts?|director(?:y|ies)|dirs?|worktrees?)\b/i;
/** Any word that could qualify or take back the verdict above it keeps the final message whole. */
const QUALIFIER = /attest|withdr|retract|revok|correct|reflect|\bnot\b|n't|\bbut\b|however|instead|follow|author|probe/i;
const LENDING_LABELS = [ATTESTS_HEADING, FOLLOW_UPS_HEADING, AUTHORITY_HEADING, PROBES_HEADING];

interface MergeBlock {
  repo: string;
  pr: number;
  head: string;
  /** The zero-based line of the block's Verdict line. */
  lineOffset: number;
}

const isLabelled = (line: string): boolean => LENDING_LABELS.some((label) => labelledLineRest(line, label) !== undefined);

const isCleanupNote = (line: string): boolean => line.trim() === "" || (CLEANUP_NOTE.test(line) && !QUALIFIER.test(line));

/**
 * The verdict block alone, or after a short note that the reviewer removed its checkout: the shape a reviewer writes
 * after cleanup. Any other prose (a withdrawal, a correction, a qualifier) makes the final message stand on its own, so
 * a refusal is never read as the grant it refuses.
 */
function isBare(text: string, verdictAt: number): boolean {
  const preface = visibleLines(text).slice(0, verdictAt);
  if (preface.some((line) => line === null)) return false;
  const lines = preface.filter((line) => line !== null);
  return lines.join("\n").trim().length < BARE_PREFACE_CHARS && lines.every(isCleanupNote) && !text.split("\n").some(isLabelled);
}

/** The Verdict line of `text` when it carries the target's MERGE block; `other` for any other block, a refused one included, `none` for no block. */
function sameMergeAt(text: string, target: MergeBlock): number | "other" | "none" {
  const block = parseVerdictBlock(text);
  if (!("repo" in block)) return block.reason === "no_block" ? "none" : "other";
  const same = block.ok && block.verdict === "MERGE" && block.repo === target.repo && block.pr === target.pr && block.head === target.head;
  return same ? block.lineOffset : "other";
}

/**
 * The message a MERGE's Attests and Follow-ups are read from: the final one, unless it is a bare repeat; then the latest
 * earlier non-bare message, from `earlier` (the dispatched session's own, oldest first), that carries the identical MERGE
 * block. A block naming anything else on the way back ends the search, so a withdrawn or superseded draft lends nothing.
 */
export function labelSource(final: ReviewerMessage, target: MergeBlock, earlier: readonly ReviewerMessage[]): ReviewerMessage {
  if (!isBare(final.text, target.lineOffset)) return final;
  for (const message of [...earlier].reverse()) {
    const verdictAt = sameMergeAt(message.text, target);
    if (verdictAt === "other") return final;
    if (verdictAt !== "none" && !isBare(message.text, verdictAt)) return message;
  }
  return final;
}
