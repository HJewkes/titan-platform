import { labelledLineRest, parseVerdictBlock, visibleLines } from "@titan-design/session-read";
import { AUTHORITY_HEADING, PROBES_HEADING } from "./briefs/adversary.js";
import { ATTESTS_HEADING } from "./briefs/attest.js";
import { FOLLOW_UPS_HEADING } from "./follow-ups.js";
import type { ReviewerMessage } from "./ports.js";

/** Above this much text before its Verdict line, a final message is a review in its own right, never a repeat. */
export const BARE_PREFACE_CHARS = 400;
const LENDING_LABELS = [ATTESTS_HEADING, FOLLOW_UPS_HEADING, AUTHORITY_HEADING, PROBES_HEADING];

interface MergeBlock {
  repo: string;
  pr: number;
  head: string;
  /** The zero-based line of the block's Verdict line. */
  lineOffset: number;
}

const isLabelled = (line: string): boolean => LENDING_LABELS.some((label) => labelledLineRest(line, label) !== undefined);

/** A short repeat of the verdict block with no labelled line anywhere, the shape a reviewer writes after its cleanup. */
function isBare(text: string, verdictAt: number): boolean {
  const preface = visibleLines(text).slice(0, verdictAt).filter((line) => line !== null).join("\n");
  return preface.trim().length < BARE_PREFACE_CHARS && !text.split("\n").some(isLabelled);
}

/** The Verdict line of `text` when it carries the target's MERGE block; `other` for any other block, `none` for no block. */
function sameMergeAt(text: string, target: MergeBlock): number | "other" | "none" {
  const block = parseVerdictBlock(text);
  if (!("repo" in block)) return "none";
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
