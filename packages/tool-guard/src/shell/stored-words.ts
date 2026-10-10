import type { Token, WordToken } from "./lexer.js";
import { arrayElements } from "./declarations.js";
import { noteTyped } from "./value-marks.js";
import type { ValueMarks } from "./value-marks.js";
import { parseAssignment } from "./vars.js";
import { evaluatesArithmetic } from "./writers.js";

/** A command's words, the operator that ends it, and the operator before it. */
interface CommandWords {
  op: Token | null;
  words: WordToken[];
  prev: string | null;
}

const DECLARERS = new Set(["export", "declare", "typeset", "local", "readonly"]);
const ELEMENT_WRITE_RE = /^[A-Za-z_]\w*\[.*\](\+?)=/s;
const DEFAULT_ASSIGN_RE = /\$\{[A-Za-z_]\w*:?=/;

/**
 * Notes whether a command evaluates arithmetic, and hands `hear` the values it stores that its variables do not
 * hold: each element of a compound array and each element write. A `${X:=...}` default and positional parameters,
 * which `set` or a function call fill, store text the walk cannot know.
 */
export function noteCommand(marks: ValueMarks, { op, words: all, prev }: CommandWords, hear: (value: string | null) => void): void {
  const words = afterKeywords(all);
  const head = words.findIndex((word) => parseAssignment(word) === null);
  marks.arithmetic ||= evaluatesArithmetic(op, words, head);
  const header = (op?.type === "op" && op.value === ")" && all.length === 0 && prev === "(") || words[head]?.value === "function";
  if (header || setsPositional(head < 0 ? [] : words.slice(head)) || words.some((word) => DEFAULT_ASSIGN_RE.test(word.value))) marks.opaque = true;
  for (const element of words.flatMap((word) => arrayElements.get(word) ?? [])) hear(element.dynamic ? null : noteWord(element, marks).value);
  const assigning = head < 0 || DECLARERS.has(words[head]?.value ?? "") ? words : words.slice(0, head);
  for (const word of assigning) hearElementWrite(word, hear);
}

/**
 * `set` stores positional parameters only from operands: those after `--` or `-`, or the first word that is no
 * option. `-o` and `+o` take the next word as an option name; a word known only at run time may be anything.
 */
function setsPositional([name, ...args]: WordToken[]): boolean {
  if (name?.value !== "set") return false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as WordToken;
    if (arg.dynamic || arg.value === "--" || arg.value === "-" || !/^[-+]/.test(arg.value)) return true;
    if (/^[-+][A-Za-z]*o$/.test(arg.value)) i++;
  }
  return false;
}

/** `a[i]=text` stores text the variables do not keep; an append or an expansion in it stores text the walk cannot know. */
function hearElementWrite(word: WordToken, hear: (value: string | null) => void): void {
  const parts = ELEMENT_WRITE_RE.exec(word.value);
  if (!parts) return;
  const text = word.value.slice(parts[0].length);
  hear(parts[1] === "+" || /[$`]/.test(text) ? null : text);
}

/** Bash leaves a bare `[` or `[[` out of every value. */
export function noteWord(word: WordToken, marks: ValueMarks): WordToken {
  if (word.quoted || (word.value !== "[" && word.value !== "[[")) noteTyped(marks, word.value);
  return word;
}

/** Keywords that start a command's own words but are not part of them: `do X=1`, `then (( X ))`. */
const LEADING_WORDS = new Set(["if", "then", "else", "elif", "while", "until", "do", "{", "!", "time"]);
function afterKeywords(words: WordToken[]): WordToken[] {
  const start = words.findIndex((word) => word.quoted || !LEADING_WORDS.has(word.value));
  return start < 0 ? [] : words.slice(start);
}
