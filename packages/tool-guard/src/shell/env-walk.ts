import { argv0Values } from "./argv0.js";
import { envArgv } from "./env-argv.js";
import type { EnvSyntax } from "./env-argv.js";
import type { WordToken } from "./lexer.js";
import { parseAssignment } from "./vars.js";
import type { Assignment } from "./vars.js";

/** How env's leading words read: its options, how they are spelled, and which words are the shell's keywords. */
export interface EnvWalkSyntax extends EnvSyntax {
  spell: (word: WordToken) => string | null;
  keyword: (word: WordToken) => boolean;
}

/**
 * The line's words once env's leading words are read: the same array unless a `-S` string changed them, `end` the
 * first word past them, and `ambiguousAt` an option that abbreviates several. A spelled-out option changes no word,
 * since its value is read here and any later reading of the line spells it again, and a copy per env would make a
 * line of envs quadratic.
 */
interface EnvWalk {
  words: WordToken[];
  end: number;
  argv0: Array<string | null>;
  negated: boolean;
  ambiguousAt?: number;
}

/** A run of words to read from: the line's own at the bottom, each `-S` string's above the words after it. */
interface Source {
  words: WordToken[];
  at: number;
}

interface Walk {
  stack: Source[];
  read: WordToken[];
  argv0: Array<string | null>;
  changed: boolean;
  negated: boolean;
  syntax: EnvWalkSyntax;
}

/**
 * env's options, `-S` strings, assignments and keywords from `start` on, read once in order. uutils env still reads a
 * `-S` after its `NAME=VALUE` words, so its options resume after them, and a word with a `=` the shell does not name
 * (`a.b=1`) is still env's assignment. A `-S` string's words are read in place of the option, never spliced into the
 * line, so the walk stays linear in the line. Null when a `-S` string's words cannot be known.
 */
export function walkEnv(words: WordToken[], start: number, assigned: Assignment[], syntax: EnvWalkSyntax): EnvWalk | null {
  const walk: Walk = { stack: [{ words, at: start }], read: [], argv0: [], changed: false, negated: false, syntax };
  let options = readOptions(walk);
  for (let w = peek(walk.stack); options === "read" && w !== undefined; w = peek(walk.stack)) {
    const assignment = parseAssignment(w);
    if (syntax.keyword(w)) walk.negated ||= w.value === "!";
    else if (assignment) assigned.push(assignment);
    else if (!w.dynamic && w.value.startsWith("-")) {
      options = readOptions(walk);
      continue;
    } else if (w.dynamic || !w.value.includes("=")) break;
    walk.read.push(w);
    take(walk.stack);
  }
  if (options === null) return null;
  return { ...lineWords(walk, words, start), argv0: walk.argv0, negated: walk.negated, ...(options === "ambiguous" ? { ambiguousAt: start + walk.read.length } : {}) };
}

/** One run of env's options, as a pass of env's own option parser reads it, up to its first other word or a `--`. */
function readOptions(walk: Walk): "read" | "ambiguous" | null {
  const run: WordToken[] = [];
  for (let w = peek(walk.stack); w?.value.startsWith("-"); w = peek(walk.stack)) {
    const value = w.value === "--" ? w.value : walk.syntax.spell(w);
    if (value === null) return "ambiguous";
    const word = value === w.value ? w : { ...w, value };
    take(walk.stack);
    const at = value === "--" ? null : walk.syntax.scriptAt(value);
    if (at !== null) {
      const argv = envArgv(word, at, at === "next" ? take(walk.stack) : undefined, walk.syntax);
      if (argv === null) return null;
      walk.stack.push({ words: argv, at: 0 });
      walk.changed = true;
      continue;
    }
    const taken = value !== "--" && walk.syntax.takesValue(value) ? take(walk.stack) : undefined;
    for (const read of taken ? [word, taken] : [word]) {
      run.push(read);
      walk.read.push(read);
    }
    if (value === "--") break;
  }
  for (const name of argv0Values("env", run)) walk.argv0.push(name);
  return "read";
}

/** The line's words with env's read words and any `-S` words still unread in place of what was written. */
function lineWords(walk: Walk, words: WordToken[], start: number): { words: WordToken[]; end: number } {
  const bottom = walk.stack[0]?.at ?? start;
  if (!walk.changed) return { words, end: bottom };
  const unread = walk.stack.slice(1).reverse().flatMap((s) => s.words.slice(s.at));
  return { words: [...words.slice(0, start), ...walk.read, ...unread, ...words.slice(bottom)], end: start + walk.read.length };
}

function peek(stack: Source[]): WordToken | undefined {
  for (let top = stack.at(-1); top !== undefined; top = stack.at(-1)) {
    const word = top.words[top.at];
    if (word !== undefined || stack.length === 1) return word;
    stack.pop();
  }
  return undefined;
}

function take(stack: Source[]): WordToken | undefined {
  const word = peek(stack);
  const top = stack.at(-1);
  if (word !== undefined && top !== undefined) top.at++;
  return word;
}
