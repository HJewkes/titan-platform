import { MIN_QUOTE_WORDS } from "./eval-evidence.js";
import { spokenText } from "./lint-register.js";

/** A judge mark or extracted term, as the model gave it. */
interface RawMark {
  id: string;
  quote: string;
}

interface RawTerm {
  term: string;
}

/** A verified mark: its checklist item and the span of the piece it quotes. */
export interface PlacedMark {
  id: string;
  start: number;
  end: number;
}

/** A verified term and the number of words before its first appearance. */
export interface PlacedTerm {
  term: string;
  atWord: number;
}

// One character for one, so offsets in the folded text are offsets in the piece. Every space separator becomes a space.
const FOLDS: readonly (readonly [RegExp, string])[] = [[/[“”]/g, '"'], [/[‘’]/g, "'"], [/[–—]/g, "-"], [/\p{Zs}/gu, " "]];
const QUOTE_EDGE = /^[\s"'“”‘’.…]+|[\s"'“”‘’.…]+$/g;

const fold = (text: string): string => FOLDS.reduce((folded, [pattern, to]) => folded.replace(pattern, to), text);
const escape = (token: string): string => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where a quote sits in the piece, tolerant of case, spacing, quote-mark style and edge punctuation only, as the
 * writing lab's `locate` is: the bands were measured with it, so a stricter match would move them.
 */
function locateQuote(text: string, quote: string): { start: number; end: number } | null {
  const tokens = fold(quote.replace(QUOTE_EDGE, "")).split(/\s+/).filter(Boolean);
  if (tokens.length < MIN_QUOTE_WORDS) return null;
  const match = new RegExp(tokens.map(escape).join("\\s+"), "i").exec(fold(text));
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

/** Keeps marks whose id is on the checklist and whose quote is in the piece; the rest are counted, never kept. */
export function verifyMarks(text: string, marks: readonly RawMark[], known: ReadonlySet<string>): { kept: PlacedMark[]; dropped: number } {
  const kept = marks.flatMap((mark) => {
    const span = known.has(mark.id) ? locateQuote(text, mark.quote) : null;
    return span === null ? [] : [{ id: mark.id, ...span }];
  });
  return { kept, dropped: marks.length - kept.length };
}

/** The term's first whole-word appearance, ignoring case; the lab keeps a term only when the piece says it. */
function termOffset(text: string, term: string): number | null {
  const tokens = fold(term).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${tokens.map(escape).join("\\s+")}(?![\\p{L}\\p{N}_])`, "iu");
  return pattern.exec(fold(text))?.index ?? null;
}

/** Keeps each term the piece says, once, in order of appearance; terms not in the piece and repeats are counted. */
export function verifyTerms(text: string, terms: readonly RawTerm[]): { kept: PlacedTerm[]; dropped: number } {
  const seen = new Set<string>();
  const kept: PlacedTerm[] = [];
  for (const { term } of terms) {
    const offset = termOffset(text, term.trim());
    if (offset === null || seen.has(term.trim().toLowerCase())) continue;
    seen.add(term.trim().toLowerCase());
    kept.push({ term: term.trim(), atWord: spokenText([text.slice(0, offset)]).words.length });
  }
  return { kept: kept.sort((a, b) => a.atWord - b.atWord), dropped: terms.length - kept.length };
}
