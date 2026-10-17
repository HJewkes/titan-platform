import { groupStdin } from "./group-stdin.js";
import type { RedirectToken, WordToken } from "./lexer.js";
import { namedFdReadings } from "./named-fd.js";
import { nextShellStdin, nextStdin } from "./piped-stdin.js";
import type { Unwrapped } from "./unwrap.js";
import type { Vars } from "./vars.js";

/** A command's readings: one, or each shell's of its `{name}` redirects, zsh's first and dash's second. */
export type Emitted = [Unwrapped | null, ...Array<Unwrapped | null>];

interface Scope {
  dir: string | null;
  vars: Vars;
}

/** The parts of a walk a command's readings hand on to the next command. */
interface HandedOn {
  scope: Scope;
  stdin: string | null;
  shellStdin: string[];
}

type EmitReading<W> = (words: WordToken[], redirects: RedirectToken[], w: W) => Unwrapped | null;

/**
 * Every shell's reading of a `{name}` redirect is walked in full, each but zsh's on a copy of the scope; any can refuse
 * the line. A directory or variable they leave different is unknown after it.
 */
export function emitReadings<W extends HandedOn>(rawWords: WordToken[], rawRedirects: RedirectToken[], w: W, beside: (w: W) => W, emitReading: EmitReading<W>): Emitted {
  const readings = namedFdReadings(rawWords, rawRedirects);
  if (!readings) return [emitReading(rawWords, rawRedirects, w)];
  const [asFd, ...others] = readings;
  const besides = others.map((reading) => ({ reading, copy: beside(w) }));
  const emitted = besides.map(({ reading, copy }) => emitReading(reading.words, reading.redirects, copy));
  const cmd = emitReading(asFd.words, asFd.redirects, w);
  for (const { copy } of besides) unknownWhereDiffer(w.scope, copy.scope);
  return [cmd, ...emitted];
}

function unknownWhereDiffer(scope: Scope, beside: Scope): void {
  if (beside.dir !== scope.dir) scope.dir = null;
  for (const key of new Set([...scope.vars.keys(), ...beside.vars.keys()])) {
    if (scope.vars.has(key) !== beside.vars.has(key) || scope.vars.get(key) !== beside.vars.get(key)) scope.vars.set(key, null);
  }
}

/**
 * Hands the next command the text this one pipes on. Every reading's printed text feeds a shell, as any may print it;
 * a group keeps dash's, as main read it.
 */
export function handOn(w: HandedOn, op: string, words: WordToken[], redirects: RedirectToken[], [cmd, word, ...rest]: Emitted): void {
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
