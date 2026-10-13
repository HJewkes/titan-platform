import { ARITH_BUILTINS } from "./builtins.js";
import { ARITH_TESTS, segments, splitCommand, type Segment } from "./ifs-writes.js";
import { DECLARERS, nameSlots } from "./name-slots.js";
import type { Token, WordToken } from "./tokens.js";
import { ASSIGNMENT_RE } from "./vars.js";

/** Parts of a word bash or zsh may read as arithmetic: `$(( ))` to the word's end, a `${ }` and a subscript. */
const ARITH_REGION_RE = /\$\(\([^]*|\$\{[^}]*\}?|\[[^\]]*\]?/g;
/** A name as arithmetic reads it, bare rather than the `$NAME` or `${NAME` an expansion opens with. */
const BARE_NAME_RE = /(?<![\w$])(?<!\$\{[#!]?)[A-Za-z_]\w*/g;
/** Values arithmetic reads as a number, never as an expression: an integer, or a brace range of them. */
const NUMBER_RE = /^(?:-?\d+|\{-?\d+\.\.-?\d+(?:\.\.-?\d+)?\})$/;
/** Writers whose operand without `=` leaves the value alone, or unsets it. */
const VALUE_KEEPERS = new Set([...DECLARERS, "unset"]);

/**
 * Whether arithmetic may evaluate the value of a variable the line writes. bash and zsh read a bare name in any
 * arithmetic context (`let x`, `(( x ))`, `$((x))`, `[[ x -eq 0 ]]`, `${s:x}`, `arr[x]`, zsh's `shift x`) as its
 * value, evaluated in turn as an expression, so a value such as `IFS=1` assigns IFS. Any value the line gives
 * other than a number may do that; a name the line never writes keeps the caller's value.
 */
export function arithReadsWrittenValue(lists: readonly Token[][]): boolean {
  const all = lists.flatMap((list) => segments(list).map((segment) => ({ segment, list })));
  const written = new Set(all.flatMap(({ segment }) => nonNumericWrites(segment)));
  if (written.size === 0) return false;
  const texts = [...all.flatMap(({ segment }) => arithTexts(segment)), ...lists.flatMap(redirectTexts)];
  return texts.some((text) => (text.match(BARE_NAME_RE) ?? []).some((name) => written.has(name)));
}

/** Names the segment writes with a value that may not be a number. Arithmetic itself only stores numbers. */
function nonNumericWrites({ words, arith }: Segment): string[] {
  if (arith) return [];
  const { command, args } = splitCommand(words);
  const leading = command ? words.slice(0, words.indexOf(command)) : words;
  const assigned = leading.filter((w) => ASSIGNMENT_RE.test(w.value));
  const slots = command ? nameSlots(command.value, args) : [];
  const named = typeof slots === "string" ? [] : slots;
  const keeps = command !== undefined && VALUE_KEEPERS.has(command.value);
  const loopsOverNumbers = command !== undefined && ["for", "select"].includes(command.value) && listsNumbers(args);
  return [...assigned, ...named]
    .filter((w) => (w.value.includes("=") ? !numericValue(w) : !keeps && !loopsOverNumbers))
    .flatMap((w) => /^[A-Za-z_]\w*/.exec(w.value)?.[0] ?? []);
}

function listsNumbers(args: WordToken[]): boolean {
  const at = args.findIndex((a) => !a.quoted && a.value === "in");
  return at >= 0 && args.slice(at + 1).every((a) => !a.dynamic && NUMBER_RE.test(a.value));
}

/** A static integer, or one arithmetic expansion and nothing after it. */
function numericValue(w: WordToken): boolean {
  const value = w.value.slice(w.value.indexOf("=") + 1);
  if (!w.dynamic) return NUMBER_RE.test(value);
  return value.startsWith("$((") && value.lastIndexOf("$((") === 0 && closesAtEnd(value);
}

/** Whether the `$((` that opens the value closes at its last character. */
function closesAtEnd(value: string): boolean {
  let depth = 0;
  for (let i = 1; i < value.length; i++) {
    depth += value[i] === "(" ? 1 : value[i] === ")" ? -1 : 0;
    if (depth === 0) return i === value.length - 1;
  }
  return false;
}

/** Text the segment may evaluate as arithmetic: all of it in `(( ))` or `let`, else its arithmetic regions. */
function arithTexts({ words, arith }: Segment): string[] {
  if (arith) return words.map((w) => w.value);
  const { command, args } = splitCommand(words);
  const whole = command ? arithArgs(command.value, args) : [];
  return [...whole.map((w) => w.value), ...words.flatMap((w) => w.value.match(ARITH_REGION_RE) ?? [])];
}

/** Arguments a command reads whole as arithmetic; printf's format is text, its values numbers. */
function arithArgs(name: string, args: WordToken[]): WordToken[] {
  if (name === "let") return args;
  if (name === "[[") return args.some((a) => ARITH_TESTS.has(a.value)) ? args : [];
  if (name === "printf") return args.slice(args[0]?.value === "-v" ? 3 : 1);
  return ARITH_BUILTINS.has(name) ? args : [];
}

function redirectTexts(list: readonly Token[]): string[] {
  return list.flatMap((t) => (t.type === "redirect" ? [t.target?.value ?? "", t.body ?? ""] : [])).flatMap((v) => v.match(ARITH_REGION_RE) ?? []);
}
