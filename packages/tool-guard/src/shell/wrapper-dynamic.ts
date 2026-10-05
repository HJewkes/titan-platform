import type { WordToken } from "./lexer.js";
import { parseAssignment } from "./vars.js";

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
  skip: (words: WordToken[], start: number, spec: OptionSpec, found?: number[]) => number;
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
  return walkChain(words, start, spec, walk).found;
}

/** The chain's dynamic option words, and the index where its last stage ends: its command. */
function walkChain(words: WordToken[], start: number, spec: OptionSpec, walk: Walk): { found: number[]; command: number } {
  const found: number[] = [];
  let command = start;
  for (let stage = { start, spec } as { start: number; spec: OptionSpec } | null; stage; ) {
    command = walk.skip(words, stage.start, stage.spec, found);
    stage = command < 0 ? null : walk.next(words, command);
  }
  return { found, command };
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

/** More dynamic option words than this along one chain are not read: the whole command fails closed, once. */
const MAX_CHAIN_DYNAMIC = 64;

/** A word list and where its words came from, to tell a word shifted into command place from one written there. */
interface Reading {
  words: WordToken[];
  /** Index of each word in the chain as written; -1 for a word the expansion made up. */
  origin: number[];
  /** Lowest index, as written, of a static word the expansion dropped. */
  dropped: number;
}

/** What `expand` spends: expansion steps left. */
interface Budget {
  left: number;
}

function literalWord(value: string): WordToken {
  return { type: "word", value, dynamic: false, quoted: false, spliced: false, computed: false, refs: [], subs: [] };
}

/**
 * Every way the first dynamic option word of the wrapper chain could expand, resolved to word lists with no dynamic
 * option word left: the word gone, the word and the next word gone (an option and its value), or the word a literal
 * positional; for `xargs`, an `-I`. Every level is expanded here, over word lists, so a reading that is parsed again
 * meets no dynamic option word and starts no expansion of its own. Null once the lists pass `budget`.
 */
function expand(r: Reading, start: number, spec: OptionSpec, walk: Walk, xargs: boolean, budget: Budget): Reading[] | null {
  const found = chainDynamics(r.words, start, spec, walk);
  const d = found[0];
  if (d === undefined) return [r];
  if (--budget.left < 0) return null;
  const word = r.words[d] as WordToken;
  const next = r.words[d + 1];
  const cut = (gone: number, insert: WordToken[]): Reading => ({
    words: [...r.words.slice(0, d), ...insert, ...r.words.slice(d + gone)],
    origin: [...r.origin.slice(0, d), ...insert.map(() => -1), ...r.origin.slice(d + gone)],
    dropped: gone === 2 && next && !next.dynamic && (r.origin[d + 1] as number) >= 0 ? Math.min(r.dropped, r.origin[d + 1] as number) : r.dropped,
  });
  const variants = [cut(1, []), cut(2, [])];
  if (!word.value.startsWith("-")) variants.push(cut(1, [literalWord("0")]));
  if (xargs) variants.push(cut(1, [literalWord("-I")]));
  const lists: Reading[] = [];
  for (const variant of variants) {
    const inner = expand(variant, start, spec, walk, xargs, budget);
    if (inner === null) return null;
    lists.push(...inner);
  }
  return lists;
}

/**
 * A dynamic word that is the command only because the expansion dropped a static word before it: a command that could
 * not run. The word that is the command as written is read apart, by `commandReading`.
 */
function shiftedCommand(r: Reading, start: number, spec: OptionSpec, walk: Walk): boolean {
  const c = walkChain(r.words, start, spec, walk).command;
  return r.words[c]?.dynamic === true && (r.origin[c] as number) > r.dropped;
}

function exactReadings(words: WordToken[], start: number, spec: OptionSpec, walk: Walk, xargs: boolean): WordToken[][] {
  const root: Reading = { words, origin: words.map((_, i) => i), dropped: Infinity };
  const lists = expand(root, start, spec, walk, xargs, { left: MAX_READINGS });
  const kept = (lists ?? []).filter((r) => !shiftedCommand(r, start, spec, walk));
  return lists === null || kept.length === 0 ? wholeChain(words, start, spec, walk) : kept.map((r) => r.words);
}

/**
 * The chain as the walk without a dynamic-option reading takes it: the first dynamic word that ends up in command place
 * is the command, and what follows its arguments, less the other dynamic option words, which a command word with a
 * dynamic argument would fail closed on whatever the command is. Null when no word does, or when the walk is cut short.
 */
function commandReading(words: WordToken[], start: number, spec: OptionSpec, walk: Walk, found: number[]): string | null {
  for (let stage = { start, spec } as { start: number; spec: OptionSpec } | null; stage; ) {
    let c = walk.skip(words, stage.start, stage.spec);
    if (c < 0) return null;
    while (words[c] && parseAssignment(words[c] as WordToken)) c++;
    if (words[c]?.dynamic) return words.slice(c).filter((_, j) => j === 0 || !found.includes(c + j)).map(quoteWord).join(" ");
    stage = walk.next(words, c);
  }
  return null;
}

/** A dynamic command word with a dynamic argument, which is how a dynamic command word fails closed: one verdict. */
const FAIL_CLOSED = `${PLACEHOLDER} ${PLACEHOLDER}`;

/**
 * Shell text that reads a dynamic word in a wrapper's option position every way it could expand (see `expand`), and the
 * word as the command when it stands there as written. A bare dynamic `xargs` word is its dynamic command, which the
 * xargs reading already fails closed on. Past `MAX_DYNAMIC` option words as written the readings drop them all at once;
 * past `MAX_READINGS` word lists the chain is read three whole ways instead (`wholeChain`), since each reading is a
 * full line and costs as much to classify as the command itself; past `MAX_CHAIN_DYNAMIC` it is not read at all.
 * Null when the wrapper's options hold no dynamic word.
 */
export function dynamicOptionReadings(words: WordToken[], at: number, start: number, spec: OptionSpec, walk: Walk): string | null {
  const own: number[] = [];
  walk.skip(words, start, spec, own);
  const d = own[0];
  if (d === undefined) return null;
  const xargs = XARGS_RE.test((words[at] as WordToken).value);
  if (xargs && !(words[d] as WordToken).value.startsWith("-")) return null;
  const chain = words.slice(at);
  const from = start - at;
  const found = chainDynamics(chain, from, spec, walk);
  if (found.length > MAX_CHAIN_DYNAMIC) return FAIL_CLOSED;
  const lists = found.length > MAX_DYNAMIC ? bulkReadings(chain, from, spec, walk, found) : exactReadings(chain, from, spec, walk, xargs);
  const lines = lists.map((list) => list.map(quoteWord).join(" "));
  return [...new Set([...lines, commandReading(chain, from, spec, walk, found) ?? ""].filter((line) => line !== ""))].join("\n");
}

/** What follows a dynamic option word when it is dropped: nothing, the next word, or the next word if it is an option. */
const FOLLOWERS: ((next: WordToken) => boolean)[] = [() => false, () => true, (next) => !next.dynamic && next.value.startsWith("-")];

/**
 * The chain read three whole ways: every dynamic option word gone, each with the word after it, and each with that word
 * only when it is an option. Each way is repeated until the stages it exposes have none left, so a reading is parsed
 * again with no expansion to start, and the readings stay three however many stages there are.
 */
function wholeChain(words: WordToken[], start: number, spec: OptionSpec, walk: Walk): WordToken[][] {
  return FOLLOWERS.map((follows) => {
    let kept = words;
    for (let found = chainDynamics(kept, start, spec, walk); found.length > 0; found = chainDynamics(kept, start, spec, walk)) {
      const gone = new Set(found);
      for (const i of found) if (kept[i + 1] && follows(kept[i + 1] as WordToken)) gone.add(i + 1);
      kept = kept.filter((_, i) => !gone.has(i));
    }
    return kept;
  });
}

/** `words` with every dynamic option word the chain still holds gone, one stage after another, so no reparse expands. */
function settled(words: WordToken[], start: number, spec: OptionSpec, walk: Walk): WordToken[] {
  let kept = words;
  for (let found = chainDynamics(kept, start, spec, walk); found.length > 0; found = chainDynamics(kept, start, spec, walk)) {
    const gone = new Set(found);
    kept = kept.filter((_, i) => !gone.has(i));
  }
  return kept;
}

/**
 * One reading per way a dynamic word could land, so the count grows by one per word, not threefold: all gone, all gone
 * with the static word after one of them (its option), and one of them a literal positional with the rest gone, with
 * or without that static word. Each is settled, so the stages it exposes are read here and not in a reparse. The three
 * whole-chain readings come with them, since a stage past the first has options of its own to drop with their values.
 */
function bulkReadings(words: WordToken[], start: number, spec: OptionSpec, walk: Walk, found: number[]): WordToken[][] {
  const dynamic = new Set(found);
  const reading = (literalAt: number | null, dropAfter: number | null) =>
    settled(
      words.flatMap((w, i) => {
        if (dynamic.has(i)) return i === literalAt ? [literalWord("0")] : [];
        return i === (dropAfter ?? -2) + 1 ? [] : [w];
      }),
      start, spec, walk,
    );
  const readings = [reading(null, null)];
  for (const k of found) readings.push(reading(null, k), reading(k, null), reading(k, k));
  return [...readings, ...wholeChain(words, start, spec, walk)];
}
