import { takesNextWord } from "./cluster.js";
import type { WordToken } from "./lexer.js";

interface OptionSpec {
  values?: string[];
  stop?: string[];
  optional?: string[];
  digits?: boolean;
}

/** An unset variable of no meaning: it stays dynamic when the reading is parsed again. */
const PLACEHOLDER = '"$__dynamic"';

/** More dynamic option words than this are read in one pass: each one triples the readings of the exact pass. */
const MAX_DYNAMIC = 4;

/**
 * Where the dynamic words sit among a wrapper's options, and the index of the word after them. A word such as `-$O`
 * counts too: its dash is known but the option letters are not.
 */
function dynamicOptions(words: WordToken[], start: number, spec: OptionSpec): { at: number[]; end: number } {
  const at: number[] = [];
  let i = start;
  for (; i < words.length; ) {
    const w = words[i] as WordToken;
    if (w.dynamic && (!w.value.startsWith("-") || w.refs.every((r) => r.start <= leadingDashes(w.value)))) at.push(i++);
    else if (!w.value.startsWith("-") || w.value === "--" || spec.stop?.includes(w.value)) break;
    else i += takesNextWord(w.value, spec) ? 2 : 1;
  }
  return { at, end: i };
}

function leadingDashes(value: string): number {
  return value.length - value.replace(/^-+/, "").length;
}

function literal(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** The word as shell text: every literal span single-quoted, so its text stays text; each expansion becomes a placeholder. */
function quoteWord(w: WordToken): string {
  if (!w.dynamic) return literal(w.value);
  const parts: string[] = [];
  let at = 0;
  for (const ref of w.refs) {
    if (ref.start > at) parts.push(literal(w.value.slice(at, ref.start)));
    parts.push(PLACEHOLDER);
    at = ref.end;
  }
  if (at < w.value.length) parts.push(literal(w.value.slice(at)));
  return (parts.includes(PLACEHOLDER) ? parts : [...parts, PLACEHOLDER]).join("");
}

/**
 * Shell text that reads a dynamic word in a wrapper's option position every way it could expand: to nothing or to
 * an option without a value (the word is gone), to an option that takes the next word (both are gone), or to
 * a positional (a literal stands in). An `xargs` option word may also be `-I`, which makes the next word its replace
 * string; a bare dynamic `xargs` word is its dynamic command, which the xargs reading already fails closed on.
 * Past `MAX_DYNAMIC` option words the readings drop them all, with and without the word after, rather than none.
 * Null when the wrapper's options hold no dynamic word.
 */
export function dynamicOptionReadings(words: WordToken[], at: number, start: number, spec: OptionSpec): string | null {
  const { at: found, end } = dynamicOptions(words, start, spec);
  const d = found[0];
  if (d === undefined) return null;
  const xargs = /(^|\/)xargs$/.test((words[at] as WordToken).value);
  const dashed = (words[d] as WordToken).value.startsWith("-");
  if (xargs && !dashed) return null;
  if (found.length > MAX_DYNAMIC) return bulkReadings(words, at, found, end);
  const before = words.slice(at, d).map(quoteWord);
  const after = words.slice(d + 1).map(quoteWord);
  const readings = [after, after.slice(1)];
  if (!dashed) readings.push(["0", ...after]);
  if (xargs) readings.push(["-I", ...after]);
  return readings.map((rest) => [...before, ...rest].join(" ")).join("\n");
}

function bulkReadings(words: WordToken[], at: number, found: number[], end: number): string {
  const kept = words.map((w, i) => (found.includes(i) ? null : quoteWord(w))).slice(at);
  const text = (skip: number) => kept.filter((w, i) => w !== null && i + at !== skip).join(" ");
  return [text(-1), text(end)].join("\n");
}
