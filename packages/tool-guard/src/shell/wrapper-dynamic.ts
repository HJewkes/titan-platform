import { takesNextWord } from "./cluster.js";
import type { WordToken } from "./lexer.js";

interface OptionSpec {
  values?: string[];
  stop?: string[];
  optional?: string[];
  digits?: boolean;
  positionals?: number;
}

/** An expansion no assignment can bind, as a variable name could be; it stays dynamic when the reading is parsed again. */
const PLACEHOLDER = '"$(:)"';

/** More dynamic option words than this are read in one pass: each one triples the readings of the exact pass. */
const MAX_DYNAMIC = 4;

const XARGS_RE = /(^|\/)xargs$/;

type SpecOf = (value: string) => OptionSpec | undefined;

/**
 * Where the dynamic words sit among a wrapper's options, and the index just past those options. A word such as `-$O`
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

/**
 * The dynamic option words of the wrapper at `at` and of every wrapper it runs in turn: one budget for the chain, since
 * a reading is parsed again and the inner wrapper would otherwise expand its own words once more for each of them.
 */
function chainDynamics(words: WordToken[], start: number, spec: OptionSpec, specOf: SpecOf): number[] {
  const found: number[] = [];
  for (let next: OptionSpec | undefined = spec, i = start; next; ) {
    const own = dynamicOptions(words, i, next);
    found.push(...own.at);
    i = own.end + (next.positionals ?? 0);
    const w = words[i];
    next = w && !w.dynamic && !XARGS_RE.test(w.value) ? specOf(w.value) : undefined;
    i++;
  }
  return found;
}

function leadingDashes(value: string): number {
  return value.length - value.replace(/^-+/, "").length;
}

function literal(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * The word as shell text. A word made of literals and plain variables keeps its literal spans, single-quoted so their
 * text stays text. The lexer records no position for a computed expansion (`$(..)`, backticks, `${v:-x}`, `$((..))`),
 * and adds nothing to `value` for a substitution, so such a word is its whole `value` as a literal plus an empty
 * substitution: it lexes back to the same `value` and stays computed, which is all the classifier reads of it.
 */
function quoteWord(w: WordToken): string {
  if (!w.dynamic) return literal(w.value);
  if (w.computed) return `${literal(w.value)}${PLACEHOLDER}`;
  const parts: string[] = [];
  let at = 0;
  for (const ref of w.refs) {
    if (ref.start > at) parts.push(literal(w.value.slice(at, ref.start)));
    parts.push(PLACEHOLDER);
    at = ref.end;
  }
  if (at < w.value.length) parts.push(literal(w.value.slice(at)));
  return parts.join("");
}

/** Word lists one command may expand to before it falls back to the one-pass reading. */
const MAX_READINGS = 256;

function literalWord(value: string): WordToken {
  return { type: "word", value, dynamic: false, quoted: false, spliced: false, computed: false, refs: [], subs: [] };
}

/**
 * Every way the first dynamic option word of the wrapper chain could expand, resolved to word lists with no dynamic
 * option word left: the word gone, the word and the next word gone (an option and its value), or the word a literal
 * positional; for `xargs`, an `-I`. Every level is expanded here, over word lists, so a reading that is parsed again
 * meets no dynamic option word and starts no expansion of its own. Null once the lists pass `budget`.
 */
function expand(words: WordToken[], start: number, spec: OptionSpec, specOf: SpecOf, xargs: boolean, budget: { left: number }): WordToken[][] | null {
  const d = chainDynamics(words, start, spec, specOf)[0];
  if (d === undefined) return [words];
  if (--budget.left < 0) return null;
  const head = words.slice(0, d);
  const variants = [[...head, ...words.slice(d + 1)], [...head, ...words.slice(d + 2)]];
  if (!(words[d] as WordToken).value.startsWith("-")) variants.push([...head, literalWord("0"), ...words.slice(d + 1)]);
  if (xargs) variants.push([...head, literalWord("-I"), ...words.slice(d + 1)]);
  const lists: WordToken[][] = [];
  for (const variant of variants) {
    const inner = expand(variant, start, spec, specOf, xargs, budget);
    if (inner === null) return null;
    lists.push(...inner);
  }
  return lists;
}

/**
 * Shell text that reads a dynamic word in a wrapper's option position every way it could expand (see `expand`).
 * A bare dynamic `xargs` word is its dynamic command, which the xargs reading already fails closed on. Past
 * `MAX_DYNAMIC` option words, or `MAX_READINGS` readings, the readings drop the words all at once instead.
 * Null when the wrapper's options hold no dynamic word.
 */
export function dynamicOptionReadings(words: WordToken[], at: number, start: number, spec: OptionSpec, specOf: SpecOf): string | null {
  const d = dynamicOptions(words, start, spec).at[0];
  if (d === undefined) return null;
  const xargs = XARGS_RE.test((words[at] as WordToken).value);
  if (xargs && !(words[d] as WordToken).value.startsWith("-")) return null;
  const found = chainDynamics(words, start, spec, specOf);
  const lists = found.length > MAX_DYNAMIC ? null : expand(words.slice(at), start - at, spec, specOf, xargs, { left: MAX_READINGS });
  if (lists === null) return bulkReadings(words, at, found);
  return [...new Set(lists.map((list) => list.map(quoteWord).join(" ")))].join("\n");
}

/**
 * One reading per way a dynamic word could land, so the count grows by one per word, not threefold: all gone, all gone
 * with the static word after one of them (its option), and one of them a literal positional with the rest gone, with
 * or without that static word.
 */
function bulkReadings(words: WordToken[], at: number, found: number[]): string {
  const text = (keep: (i: number) => string | null) =>
    words.slice(at).map((w, j) => keep(j + at) ?? (found.includes(j + at) ? null : quoteWord(w))).filter((w) => w !== null).join(" ");
  const readings = [text(() => null)];
  for (const k of found) {
    readings.push(text((i) => (i === k + 1 && !found.includes(i) ? "" : null)));
    readings.push(text((i) => (i === k ? "0" : null)));
    readings.push(text((i) => (i === k ? "0" : i === k + 1 && !found.includes(i) ? "" : null)));
  }
  return readings.join("\n");
}
