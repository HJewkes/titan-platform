import { copyGroupState, groupStdin } from "./group-stdin.js";
import type { OpToken, RedirectToken, WordToken } from "./lexer.js";
import { namedFdReadings } from "./named-fd.js";
import { nextShellStdin, nextStdin } from "./piped-stdin.js";
import type { Unwrapped } from "./unwrap.js";
import { ReadingLimitError } from "./unsure-readings.js";
import { trackCompound, type Vars } from "./vars.js";

/** A command's readings: one, or each shell's of its `{name}` redirects, zsh's first and dash's second. */
type Emitted = [Unwrapped | null, ...Array<Unwrapped | null>];

interface Scope {
  dir: string | null;
  vars: Vars;
}

/** The parts of a walk a command's readings hand on to the next command; `marks` is shared by every walk of one line. */
interface HandedOn {
  scope: Scope;
  stdin: string | null;
  shellStdin: string[];
  marks: object;
}

/** What links a command to the next on its list. */
interface Linked extends HandedOn {
  prev: string | null;
  negated: boolean;
  chain: { readonly start: string | null };
}

type EmitReading<W> = (words: WordToken[], redirects: RedirectToken[], w: W) => Unwrapped | null;

/** A command's readings, and the scope each reading leaves that differs from zsh's and from every one before it. */
export interface Emission<S> {
  readings: Emitted;
  disputed: S[];
}

/**
 * Every shell's reading of a `{name}` redirect is walked in full, each but zsh's on a copy of the scope; any can refuse
 * the line. zsh's leaves its scope on the walk; a scope another leaves different is the walk's to carry on.
 */
export function emitReadings<W extends HandedOn>(rawWords: WordToken[], rawRedirects: RedirectToken[], w: W, beside: (w: W) => W, emitReading: EmitReading<W>): Emission<W["scope"]> {
  const readings = namedFdReadings(rawWords, rawRedirects);
  if (!readings) return { readings: [emitReading(rawWords, rawRedirects, w)], disputed: [] };
  const [asFd, ...others] = readings;
  const besides = others.map((reading) => ({ reading, copy: beside(w) }));
  const emitted = besides.map(({ reading, copy }) => emitReading(reading.words, reading.redirects, copy));
  const cmd = emitReading(asFd.words, asFd.redirects, w);
  const disputed: Array<W["scope"]> = [];
  for (const { copy } of besides) if ([w.scope, ...disputed].every((scope) => differs(scope, copy.scope))) disputed.push(copy.scope);
  chargeForks(w.marks, disputed.length);
  return { readings: [cmd, ...emitted], disputed };
}

function differs(scope: Scope, beside: Scope): boolean {
  if (beside.dir !== scope.dir) return true;
  const keys = new Set([...scope.vars.keys(), ...beside.vars.keys()]);
  return [...keys].some((key) => scope.vars.has(key) !== beside.vars.has(key) || scope.vars.get(key) !== beside.vars.get(key));
}

/**
 * The walk carried on in a reading's own scope, with its own `&&` chain and copy of the scopes a `)` returns to;
 * `observe` hears what each of those scopes' variables store.
 */
export function forkWalk<W extends Linked & { stack: Array<W["scope"]> }>(w: W, scope: W["scope"], observe: (fork: W, vars: Vars) => void): W {
  const fork: W = { ...w, scope, chain: { start: w.chain.start }, stack: w.stack.map((outer) => ({ ...outer, vars: new Map(outer.vars) })) };
  for (const vars of [scope.vars, ...fork.stack.map((outer) => outer.vars)]) observe(fork, vars);
  copyGroupState(w, fork);
  return fork;
}

/** Walks of the rest of a list that one line's disputed readings may add; each walks all that follows again. */
const MAX_FORKS = 8;
const forksUsed = new WeakMap<object, number>();

/** Counts `count` more such walks against the line keyed by `line`; past the cap the line is refused unchecked. */
function chargeForks(line: object, count: number): void {
  const used = (forksUsed.get(line) ?? 0) + count;
  if (used > MAX_FORKS) throw new ReadingLimitError();
  forksUsed.set(line, used);
}

/**
 * Hands the next command the text this one pipes on. Every reading's printed text feeds a shell, as any may print it;
 * a group keeps dash's, as main read it.
 */
function handOn(w: HandedOn, op: string, words: WordToken[], redirects: RedirectToken[], [cmd, word, ...rest]: Emitted): void {
  const empty = words.length + redirects.length === 0;
  if (word === undefined) {
    w.shellStdin = nextShellStdin(op, cmd, empty, w.shellStdin);
    w.stdin = groupStdin(w, op, words, redirects, cmd, nextStdin(op, cmd, empty, w.stdin));
    return;
  }
  const printed = [cmd, word, ...rest].flatMap((reading) => [nextStdin(op, reading, empty, w.stdin), ...nextShellStdin(op, reading, empty, w.shellStdin)]);
  const texts = [...new Set(printed.filter((text) => text !== null))];
  w.shellStdin = texts.slice(1);
  w.stdin = groupStdin(w, op, words, redirects, word, texts[0] ?? null);
}

/** Ends a command at `op`: hands on what it pipes, links the next command to it, and enters or leaves a subshell. */
export function endCommand(w: Linked, token: OpToken, words: WordToken[], redirects: RedirectToken[], readings: Emitted, enter: (op: string) => void): void {
  handOn(w, token.value, words, redirects, readings);
  w.prev = token.value;
  if (token.value !== "|" && token.value !== "|&") w.negated = false;
  if (token.value !== "&&") w.chain = { start: token.value };
  trackCompound(token, w.scope.vars);
  enter(token.value);
}
