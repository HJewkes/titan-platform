import { groupStdin } from "./group-stdin.js";
import type { RedirectToken, WordToken } from "./lexer.js";
import { namedFdReadings } from "./named-fd.js";
import { nextShellStdin, nextStdin } from "./piped-stdin.js";
import type { Unwrapped } from "./unwrap.js";
import type { Vars } from "./vars.js";

/** A command's readings: one, or the fd's and the word's of a `{name}` redirect. */
export type Emitted = [Unwrapped | null] | [Unwrapped | null, Unwrapped | null];

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
 * Both readings of a `{name}` redirect are walked in full, the word's on a copy of the scope; either can refuse the line.
 * The fd's reading comes first, then the word's; a directory or variable they leave different is unknown after it.
 */
export function emitReadings<W extends HandedOn>(rawWords: WordToken[], rawRedirects: RedirectToken[], w: W, beside: (w: W) => W, emitReading: EmitReading<W>): Emitted {
  const readings = namedFdReadings(rawWords, rawRedirects);
  if (!readings) return [emitReading(rawWords, rawRedirects, w)];
  const [kept, asFd] = readings;
  const copy = beside(w);
  const word = emitReading(kept.words, kept.redirects, copy);
  const cmd = emitReading(asFd.words, asFd.redirects, w);
  unknownWhereDiffer(w.scope, copy.scope);
  return [cmd, word];
}

function unknownWhereDiffer(scope: Scope, beside: Scope): void {
  if (beside.dir !== scope.dir) scope.dir = null;
  for (const key of new Set([...scope.vars.keys(), ...beside.vars.keys()])) {
    if (scope.vars.has(key) !== beside.vars.has(key) || scope.vars.get(key) !== beside.vars.get(key)) scope.vars.set(key, null);
  }
}

/**
 * Hands the next command the text this one pipes on. Both readings' printed texts feed a shell, as either may print it;
 * a group keeps the word's, as main read it.
 */
export function handOn(w: HandedOn, op: string, words: WordToken[], redirects: RedirectToken[], [cmd, word]: Emitted): void {
  const empty = words.length + redirects.length === 0;
  if (word === undefined) {
    w.shellStdin = nextShellStdin(op, cmd, empty, w.shellStdin);
    w.stdin = groupStdin(w, op, words, redirects, cmd, nextStdin(op, cmd, empty, w.stdin));
    return;
  }
  const printed = [cmd, word].flatMap((reading) => [nextStdin(op, reading, empty, w.stdin), ...nextShellStdin(op, reading, empty, w.shellStdin)]);
  const texts = [...new Set(printed.filter((text) => text !== null))];
  w.shellStdin = texts.slice(1);
  w.stdin = groupStdin(w, op, words, redirects, word, texts[0] ?? null);
}
