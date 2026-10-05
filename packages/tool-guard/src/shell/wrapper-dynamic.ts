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

/** The one step of the wrapper walk that `unwrap` shares: past a stage's options, `--` and positionals, to its command. */
interface Walk {
  /** Index just past the stage at `start`, collecting the dynamic option words into `found`; -1 for an option that stops. */
  skip: (words: WordToken[], start: number, spec: OptionSpec, found: number[]) => number;
  /** The wrapper or runner that `unwrap` would step into at `i`, past assignments and keywords; null when none. */
  next: (words: WordToken[], i: number) => { start: number; spec: OptionSpec } | null;
}

/** Whether `w` could be an option word of a wrapper: dynamic, with no known letter after its dashes. `-$O` counts. */
export function isDynamicOption(w: WordToken): boolean {
  return w.dynamic && (!w.value.startsWith("-") || w.refs.every((r) => r.start <= leadingDashes(w.value)));
}

/**
 * The dynamic option words of the wrapper at `start` and of every wrapper it runs in turn, walked as `unwrap` walks
 * them: one budget for the chain, since a reading is parsed again and would otherwise expand the next stage once more.
 */
function chainDynamics(words: WordToken[], start: number, spec: OptionSpec, walk: Walk): number[] {
  const found: number[] = [];
  for (let stage = { start, spec } as { start: number; spec: OptionSpec } | null; stage; ) {
    const end = walk.skip(words, stage.start, stage.spec, found);
    stage = end < 0 ? null : walk.next(words, end);
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
function expand(words: WordToken[], start: number, spec: OptionSpec, walk: Walk, xargs: boolean, budget: { left: number }): WordToken[][] | null {
  const d = chainDynamics(words, start, spec, walk)[0];
  if (d === undefined) return [words];
  if (--budget.left < 0) return null;
  const head = words.slice(0, d);
  const variants = [[...head, ...words.slice(d + 1)], [...head, ...words.slice(d + 2)]];
  if (!(words[d] as WordToken).value.startsWith("-")) variants.push([...head, literalWord("0"), ...words.slice(d + 1)]);
  if (xargs) variants.push([...head, literalWord("-I"), ...words.slice(d + 1)]);
  const lists: WordToken[][] = [];
  for (const variant of variants) {
    const inner = expand(variant, start, spec, walk, xargs, budget);
    if (inner === null) return null;
    lists.push(...inner);
  }
  return lists;
}

/**
 * Shell text that reads a dynamic word in a wrapper's option position every way it could expand (see `expand`).
 * A bare dynamic `xargs` word is its dynamic command, which the xargs reading already fails closed on. Past
 * `MAX_DYNAMIC` option words as written the readings drop them all at once; past `MAX_READINGS` word lists the
 * chain is read three whole ways instead (`wholeChain`), since each reading is a full line and costs as much to
 * classify as the command itself.
 * Null when the wrapper's options hold no dynamic word.
 */
export function dynamicOptionReadings(words: WordToken[], at: number, start: number, spec: OptionSpec, walk: Walk): string | null {
  const own: number[] = [];
  walk.skip(words, start, spec, own);
  const d = own[0];
  if (d === undefined) return null;
  const xargs = XARGS_RE.test((words[at] as WordToken).value);
  if (xargs && !(words[d] as WordToken).value.startsWith("-")) return null;
  const found = chainDynamics(words, start, spec, walk);
  if (found.length > MAX_DYNAMIC) return bulkReadings(words, at, found);
  const lists = expand(words.slice(at), start - at, spec, walk, xargs, { left: MAX_READINGS });
  if (lists === null) return wholeChain(words.slice(at), start - at, spec, walk);
  return [...new Set(lists.map((list) => list.map(quoteWord).join(" ")))].join("\n");
}

/** What follows a dynamic option word when it is dropped: nothing, the next word, or the next word if it is an option. */
const FOLLOWERS: ((next: WordToken) => boolean)[] = [() => false, () => true, (next) => !next.dynamic && next.value.startsWith("-")];

/**
 * The chain read three whole ways: every dynamic option word gone, each with the word after it, and each with that word
 * only when it is an option. Each way is repeated until the stages it exposes have none left, so a reading is parsed
 * again with no expansion to start, and the readings stay three however many stages there are.
 */
function wholeChain(words: WordToken[], start: number, spec: OptionSpec, walk: Walk): string {
  const lines = FOLLOWERS.map((follows) => {
    let kept = words;
    for (let found = chainDynamics(kept, start, spec, walk); found.length > 0; found = chainDynamics(kept, start, spec, walk)) {
      const gone = new Set(found);
      for (const i of found) if (kept[i + 1] && follows(kept[i + 1] as WordToken)) gone.add(i + 1);
      kept = kept.filter((_, i) => !gone.has(i));
    }
    return kept.map(quoteWord).join(" ");
  });
  return [...new Set(lines)].join("\n");
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
