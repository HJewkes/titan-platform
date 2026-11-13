import { labelledLineRest, parseVerdictBlock, visibleLines } from "@titan-design/session-read";
import { AUTHORITY_HEADING, PROBES_HEADING } from "./briefs/adversary.js";
import { ATTESTS_HEADING } from "./briefs/attest.js";
import { FOLLOW_UPS_HEADING } from "./follow-ups.js";
import type { ReviewerMessage } from "./ports.js";

/** A cleanup note is one short sentence; longer prose is a review in its own right, never a repeat. */
const BARE_NOTE_CHARS = 200;
/** The only prose a bare repeat may carry: the reviewer saying it removed its checkout. */
const CLEANUP_NOTE = /\b(?:remov|delet|clean)\w*\b.*\b(?:checkouts?|director(?:y|ies)|dirs?|worktrees?)\b/i;
/** Any word that could qualify or take back the verdict above it keeps the final message whole. */
const QUALIFIER = /attest|withdr|retract|revok|correct|reflect|\bnot\b|n't|\bbut\b|however|instead|follow|author|probe/i;
/** The one line the parser reads directly after Head: a MERGE's CI-policy or a FIX_FIRST's Closer. */
const BLOCK_TAIL = /^(?:CI-policy|Closer):/;
const LENDING_LABELS = [ATTESTS_HEADING, FOLLOW_UPS_HEADING, AUTHORITY_HEADING, PROBES_HEADING];

interface MergeBlock {
  repo: string;
  pr: number;
  head: string;
  /** The zero-based line of the block's Verdict line. */
  lineOffset: number;
}

const isLabelled = (line: string): boolean => LENDING_LABELS.some((label) => labelledLineRest(line, label) !== undefined);

const isCleanupNote = (line: string): boolean => CLEANUP_NOTE.test(line) && !QUALIFIER.test(line);

/** The block's own lines: Verdict, PR, Head, and the one optional line the parser reads right after Head. */
function blockLines(lines: readonly (string | null)[], verdictAt: number | undefined): Set<number> {
  if (verdictAt === undefined) return new Set();
  const own = [verdictAt, verdictAt + 1, verdictAt + 2];
  if (BLOCK_TAIL.test(lines[verdictAt + 3] ?? "")) own.push(verdictAt + 3);
  return new Set(own);
}

/**
 * Nothing but the block (when `verdictAt` names one), blank lines and a short note that the reviewer removed its
 * checkout: the shape a reviewer writes after cleanup. Every other line, above or below the block, hidden or visible,
 * makes the message stand on its own, so a withdrawal or qualifier anywhere is never read as silence.
 */
function isBare(text: string, verdictAt: number | undefined): boolean {
  const raw = text.split("\n");
  const lines = visibleLines(text);
  const own = blockLines(lines, verdictAt);
  const prose = lines.filter((line, index) => !own.has(index) && raw[index]!.trim() !== "");
  if (prose.some((line) => line === null) || raw.some(isLabelled)) return false;
  const notes = prose.filter((line) => line !== null);
  return notes.join("\n").length < BARE_NOTE_CHARS && notes.every(isCleanupNote);
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
 * block. On the way back only bare messages (a bare repeat, a cleanup note, nothing) are passed over: any other block,
 * and any prose with no block, ends the search, so whatever the reviewer wrote after its draft, the draft lends nothing.
 */
export function labelSource(final: ReviewerMessage, target: MergeBlock, earlier: readonly ReviewerMessage[]): ReviewerMessage {
  if (!isBare(final.text, target.lineOffset)) return final;
  for (const message of [...earlier].reverse()) {
    const verdictAt = sameMergeAt(message.text, target);
    if (verdictAt === "other") return final;
    const blockAt = verdictAt === "none" ? undefined : verdictAt;
    if (isBare(message.text, blockAt)) continue;
    return blockAt === undefined ? final : message;
  }
  return final;
}
