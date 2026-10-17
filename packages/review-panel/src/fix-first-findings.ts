import { parseVerdictBlock } from "@titan-design/session-read";
import type { ReviewTarget, ReviewerMessage } from "./ports.js";
import { namesTarget } from "./verdict-target.js";

/** The most of a FIX_FIRST's findings the step output keeps, marker included. */
export const MAX_FIX_FIRST_TEXT_CHARS = 16_000;
/** Leads findings cut to the cap; the newest findings sit at the end, so the start is what goes. */
export const FIX_FIRST_TRUNCATED = "[earlier findings truncated]\n";
/** Separates two of the reviewer's FIX_FIRST messages in the findings the fixer is handed. */
export const FINDINGS_SEPARATOR = "\n\n---\n\n";
export const BLOCK_LINE = /^\s*(?:Verdict|PR|Head|Closer):/;

/** What a verdict message says beside its block; empty when it is the block alone. */
export const findingsText = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !BLOCK_LINE.test(line))
    .join("\n")
    .trim();

function isFixFirstAt(target: ReviewTarget, text: string): boolean {
  const block = parseVerdictBlock(text);
  return "repo" in block && block.ok && block.verdict === "FIX_FIRST" && namesTarget(block, target);
}

export function boundedFindings(text: string, max = MAX_FIX_FIRST_TEXT_CHARS): string {
  if (text.length <= max) return text;
  return FIX_FIRST_TRUNCATED + text.slice(text.length - (max - FIX_FIRST_TRUNCATED.length));
}

/**
 * The findings a fixer is handed for a FIX_FIRST at this head: every FIX_FIRST naming it that says something beside its block,
 * oldest first and without repeats, cut from the start so the newest survive. A reviewer can restate the block under a
 * postscript, or under a fuller list once a background task ends, so no one message stands for the rest. Callers pass only
 * messages their agent, session and dispatch guards let through; `fallback` is the verdict message, used when none says more.
 */
export function fixFirstFindings(target: ReviewTarget, messages: readonly ReviewerMessage[], fallback: string, heading = ""): string {
  const said = messages.filter((message) => Number.isFinite(message.writtenAt) && findingsText(message.text) !== "" && isFixFirstAt(target, message.text));
  const texts = [...new Set([...said].sort((a, b) => a.writtenAt - b.writtenAt).map((message) => message.text))];
  return heading + boundedFindings(texts.length === 0 ? fallback : texts.join(FINDINGS_SEPARATOR), MAX_FIX_FIRST_TEXT_CHARS - heading.length);
}

/** The line a reviewer lists, as its own blocking item, when it could not read CI at this head; Shepherd re-reviews a FIX_FIRST holding only it. */
export const CI_UNREAD_LINE = "Blocking: CI unread";

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const BLOCKING_LINE = /^\s*blocking:/i;
const DEFECT_CLASS_LINE = /^[\s#*]*defect class:/i;

/**
 * True when a FIX_FIRST's only blocking item is the CI-unread line: the exact line, bare or as a list item, and no other list
 * item before the defect-class section. Anything else a reviewer listed may be a real finding, so it keeps the FIX_FIRST.
 */
export function ciUnreadOnly(text: string): boolean {
  const lines = findingsText(text).split("\n");
  const end = lines.findIndex((line) => DEFECT_CLASS_LINE.test(line));
  const items = (end < 0 ? lines : lines.slice(0, end)).filter((line) => LIST_ITEM.test(line) || BLOCKING_LINE.test(line));
  return items.length === 1 && items[0]?.replace(LIST_ITEM, "").trim() === CI_UNREAD_LINE;
}

/** The line a reviewer adds for each blocking item that contradicts a recorded owner pick. */
export const OWNER_PICK_CONTRADICTED = "Owner pick contradicted:";

/** The recorded pick ids a reviewer's text names on contradiction lines, each once; an id not recorded is ignored. */
export function contradictedPicks(text: string, ids: readonly string[]): string[] {
  const named = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(OWNER_PICK_CONTRADICTED))
    .map((line) => line.slice(OWNER_PICK_CONTRADICTED.length).trim());
  return [...new Set(named.filter((id) => ids.includes(id)))];
}
