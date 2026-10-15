import type { Transcript } from "./schemas.js";
import { SequenceMatcher } from "./sequence-matcher.js";

/**
 * Folds formatting and punctuation so a script and a transcript compare on their words:
 * lower case, no quotes, `*`, `_` or brackets, `u.s.` as `us`, hyphenated compounds split,
 * and every other non-word character dropped.
 */
export function normalize(text: string): string {
  // The original also had an ellipsis-dots step and a possessive step. Earlier steps
  // already remove every dot and apostrophe, so both were no-ops and are left out.
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/["']/g, "")
    .replace(/\*+/g, "")
    .replace(/_+/g, "")
    .replace(/[()]/g, "")
    .replace(/([a-z])\.\s*([a-z])\./g, "$1$2")
    .replace(/[.:;,!?]+/g, " ")
    .replace(/…+/g, "")
    .replace(/([a-z]+)-([a-z]+)/g, "$1 $2")
    .replace(/[^\p{L}\p{N}_\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface WordDiff {
  /** Character-level `SequenceMatcher.ratio()` of the two normalised texts. */
  similarity: number;
  passed: boolean;
  issues: string[];
  /** Up to five heard words that the script lacks, in the order first heard. */
  insertions: string[];
  /** Up to five script words that were not heard, in script order. */
  deletions: string[];
  normalizedExpected: string;
  normalizedActual: string;
}

export interface DiffOptions {
  /** The similarity at or above which the take passes. Default 0.9. */
  threshold?: number;
}

const MAX_LISTED = 5;

/** Compares a script with what was heard: character similarity of the normalised texts, plus word lists. */
export function diff(expected: string, heard: string | Pick<Transcript, "text">, opts: DiffOptions = {}): WordDiff {
  const threshold = opts.threshold ?? 0.9;
  const normalizedExpected = normalize(expected);
  const normalizedActual = normalize(typeof heard === "string" ? heard : heard.text);
  const similarity = new SequenceMatcher(normalizedExpected, normalizedActual).ratio();
  const passed = similarity >= threshold;
  const deletions = missingFrom(normalizedExpected, normalizedActual);
  const insertions = missingFrom(normalizedActual, normalizedExpected);
  const issues: string[] = [];
  if (!passed) issues.push(`Similarity ${percent(similarity)} below threshold ${percent(threshold)}`);
  if (deletions.length) issues.push(`Missing words: ${deletions.join(", ")}`);
  if (insertions.length) issues.push(`Extra words: ${insertions.join(", ")}`);
  return { similarity, passed, issues, insertions, deletions, normalizedExpected, normalizedActual };
}

/** Python took these from set differences in hash order; first-seen order keeps the output stable. */
function missingFrom(source: string, other: string): string[] {
  const present = new Set(words(other));
  return [...new Set(words(source))].filter((word) => !present.has(word)).slice(0, MAX_LISTED);
}

function words(text: string): string[] {
  return text.split(" ").filter(Boolean);
}

function percent(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
