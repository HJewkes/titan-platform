import type { WordToken } from "./lexer.js";
import { arrayElements } from "./declarations.js";
import { PASS_THROUGH } from "./vars.js";

const SUBSCRIPT_WRITE_RE = /^[A-Za-z_]\w*\[.*\]\+?=/s;
/** `{b[i]}>file` stores a new descriptor in the element, so bash evaluates its subscript. */
const FD_VARIABLE_RE = /^\{[A-Za-z_]\w*\[.*\]\}$/s;
/** An element read, a substring offset or length of a variable or the positional parameters, an indirect expansion, or a `$[ ]`. */
const EXPANSION_RE = /\$\{[!#]?[A-Za-z_]\w*\[|\$\{(?:[A-Za-z_]\w*(?:\[[^\]]*\])?|\d+|[@*]):(?![-=+?])|\$\{!|\$\[/;
const DECLARER_RE = /^(?:declare|typeset|local)$/;
/** `-i` evaluates what a name is set to; `-n` makes a name whose value names another, subscript and all. */
const EVALUATING_OPTION_RE = /^-[a-zA-Z]*[in]/;

/**
 * Whether a command's words make bash evaluate arithmetic apart from `(( ))`, `let` and `[[`: a `$[ ]`, an array
 * subscript written, read or keyed in a compound array, a subscripted descriptor variable, a substring offset, an
 * indirect expansion, or the names a `declare -i` or `-n` lists.
 */
export function wordsEvaluateArithmetic(words: WordToken[]): boolean {
  const values = words.map((w) => w.value);
  if (values.some((v) => SUBSCRIPT_WRITE_RE.test(v) || EXPANSION_RE.test(v))) return true;
  if (words.some((w) => !w.quoted && FD_VARIABLE_RE.test(w.value))) return true;
  if (words.some((w) => (arrayElements.get(w) ?? []).some((e) => e.value.startsWith("[")))) return true;
  const at = values.findIndex((v) => DECLARER_RE.test(v));
  return at >= 0 && values.slice(at + 1).some((v) => EVALUATING_OPTION_RE.test(v));
}

/** Builtins that store into, or test, the variables their operands name, and evaluate a subscript in that name. */
const NAME_TAKERS = new Set(["read", "printf", "getopts", "wait", "declare", "typeset", "local", "export", "readonly"]);
/** The `read` options that take a value, which names no variable. */
const READ_VALUE_OPTIONS = new Set(["-d", "-i", "-n", "-N", "-p", "-t", "-u"]);
const SUBSCRIPTED_NAME_RE = /^[A-Za-z_]\w*\[/;

/**
 * Whether a builtin is handed a variable name with a subscript, or one known only at run time, which may hold one:
 * `printf -v 'b[X]'`, `read 'b[X]'`, `read "$N"`. `command` starts at the command word; `builtin`, `command` and
 * `time` before it, with their `-p` and `--`, still run the builtin in this shell.
 */
export function nameOperandEvaluates(command: WordToken[]): boolean {
  const start = command.findIndex((w) => !PASS_THROUGH.has(w.value) && w.value !== "-p" && w.value !== "--");
  const [head, ...args] = start < 0 ? [] : command.slice(start);
  if (head === undefined || !NAME_TAKERS.has(head.value)) return false;
  return nameOperands(head.value, args).some((w) => w.dynamic || SUBSCRIPTED_NAME_RE.test(w.value));
}

function nameOperands(name: string, args: WordToken[]): WordToken[] {
  if (name === "printf") {
    const first = args[0];
    if (first === undefined || !first.value.startsWith("-v")) return [];
    return first.value === "-v" ? args.slice(1, 2) : [{ ...first, value: first.value.slice(2) }];
  }
  if (name === "read") return args.filter((w, i) => !READ_VALUE_OPTIONS.has(args[i - 1]?.value ?? ""));
  return args;
}
