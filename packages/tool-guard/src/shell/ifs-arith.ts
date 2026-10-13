import { ARITH_BUILTINS } from "./builtins.js";
import { ARITH_TESTS, isRunTime, segments, splitCommand, type Segment } from "./ifs-writes.js";
import { DECLARERS, nameSlots } from "./name-slots.js";
import type { Token, WordToken } from "./tokens.js";
import { ASSIGNMENT_RE } from "./vars.js";

/** `$(( ))` to the word's end, or a `$[ ]`. */
const ARITH_EXPANSION_RE = /\$\(\([^]*|\$\[[^\]]*\]?/g;
/** A parameter expansion's subscript (group 1) and substring offset and length (group 2), which are arithmetic. */
const EXPANSION_ARITH_RE = /\$\{[#!]?(?:[A-Za-z_]\w*|[@*#?$!-]|\d+)(\[[^\]]*\]?)?(:(?![-=+?])[^}]*)?/g;
/** The subscript after a name, as a write slot or `[[ -v ]]` reads it. */
const SUBSCRIPT_RE = /(?<=[A-Za-z_]\w*)\[[^\]]*\]?/g;
/** A name as arithmetic reads it, bare rather than the `$NAME` or `${NAME` an expansion opens with. */
const BARE_NAME_RE = /(?<![\w$])(?<!\$\{[#!]?)[A-Za-z_]\w*/g;
/** An assignment inside arithmetic, which stores a number. */
const ARITH_ASSIGN_RE = /(?<![\w$])([A-Za-z_]\w*)\s*=(?!=)/g;
/** A `${N=…}`, `${N:=…}` or zsh `${N::=…}` expansion, which assigns N whatever text follows. */
const DEFAULT_ASSIGN_RE = /\$\{([A-Za-z_]\w*)(?:\[[^\]]*\])?:{0,2}=/g;
/** Values arithmetic reads as a number, never as an expression: an integer, or a brace range of them. */
const NUMBER_RE = /^(?:-?\d+|\{-?\d+\.\.-?\d+(?:\.\.-?\d+)?\})$/;
/** A printf format with a numeric conversion, whose argument zsh evaluates as arithmetic. */
const NUMERIC_FORMAT_RE = /%[^%a-zA-Z]*[diouxXeEfFgGaAc]/;
/** Writers whose operand without `=` leaves the value alone, or unsets it. */
const VALUE_KEEPERS = new Set([...DECLARERS, "unset"]);
/**
 * Lower-case names bash or zsh sets on its own (zsh's `${(k)parameters}` with every module loaded, and the
 * `reply`, `match`, `mbegin` and `mend` that `read`, `=~` and completion set only on use). Upper-case names
 * and `_` include every name either shell sets on its own, as REPLY, OPTARG, MAPFILE, BASH_REMATCH and MATCH.
 */
const SHELL_SET_NAMES = new Set(
  [
    "argv cdpath dirstack epochtime errnos fignore fpath funcfiletrace funcsourcetrace funcstack functrace histchars",
    "historywords jobdirs jobstates jobtexts langinfo mailpath manpath mapfile match mbegin mend module_path path",
    "pipestatus prompt psvar reply signals status sysparams userdirs usergroups watch zsh_eval_context",
  ]
    .join(" ")
    .split(" "),
);
/** A name only the line can have set, so a numeric write is its only value. */
const LINE_OWNED_RE = /^[a-z][a-z0-9_]*$/;

/** Where the line writes names: numbers only, and anything else. */
interface Writes {
  numeric: Set<string>;
  other: Set<string>;
}

/**
 * Whether arithmetic may evaluate a value that is not a number. bash and zsh read a bare name in any arithmetic
 * context (`let x`, `(( x ))`, `$((x))`, `[[ x -eq 0 ]]`, `${s:x}`, `arr[x]`, zsh's `shift x`) as its value,
 * evaluated in turn as an expression, so a value such as `IFS=1` assigns IFS. A name passes only when the line
 * writes it, every write it can see stores a number, and no shell sets that name on its own; any other name,
 * unwritten or written implicitly (REPLY, OPTARG, `_`, `${x:=…}`), answers true.
 */
export function arithReadsUnknownValue(lists: readonly Token[][]): boolean {
  const all = lists.flatMap((list) => segments(list));
  const texts = [...all.flatMap(arithTexts), ...lists.flatMap(heredocTexts)];
  const read = texts.flatMap((text) => text.match(BARE_NAME_RE) ?? []);
  if (read.length === 0) return false;
  const writes: Writes = { numeric: new Set(), other: new Set() };
  for (const segment of all) recordWrites(segment, writes);
  for (const text of texts) for (const [, name = ""] of text.matchAll(ARITH_ASSIGN_RE)) writes.numeric.add(name);
  for (const w of lists.flat()) if (w.type === "word") for (const [, name = ""] of w.value.matchAll(DEFAULT_ASSIGN_RE)) writes.other.add(name);
  return read.some((name) => !LINE_OWNED_RE.test(name) || SHELL_SET_NAMES.has(name) || !writes.numeric.has(name) || writes.other.has(name));
}

/** Sorts the segment's explicit writes by whether each stores a number. */
function recordWrites({ words, arith }: Segment, writes: Writes): void {
  if (arith) return;
  const { command, args } = splitCommand(words);
  const leading = command ? words.slice(0, words.indexOf(command)) : words;
  const slots = command ? nameSlots(command.value, args) : [];
  const keeps = command !== undefined && VALUE_KEEPERS.has(command.value);
  const loopsOverNumbers = command !== undefined && ["for", "select"].includes(command.value) && listsNumbers(args);
  for (const w of [...leading.filter((l) => ASSIGNMENT_RE.test(l.value)), ...(typeof slots === "string" ? [] : slots)]) {
    const name = /^[A-Za-z_]\w*/.exec(w.value)?.[0];
    if (name === undefined || (!w.value.includes("=") && keeps)) continue;
    const numeric = w.value.includes("=") ? numericValue(w) : loopsOverNumbers;
    (numeric ? writes.numeric : writes.other).add(name);
  }
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

/**
 * Text the segment may evaluate as arithmetic: all of `(( ))`, the operands a command reads as numbers, each
 * expansion's arithmetic part, and the subscripts of the names it writes.
 */
function arithTexts({ words, arith, redirects }: Segment): string[] {
  if (arith) return [[...words.map((w) => w.value), ...redirects].join(" ")];
  const { command, args } = splitCommand(words);
  const operands = command ? arithArgs(command.value, args) : [];
  const slots = command ? nameSlots(command.value, args) : [];
  const writes = [...words.filter((w) => ASSIGNMENT_RE.test(w.value)), ...(typeof slots === "string" ? [] : slots)];
  const subscripted = command?.value === "[[" ? [...writes, ...args] : writes;
  return [
    ...operands.map((w) => w.value),
    ...words.filter(isRunTime).flatMap((w) => expansionTexts(w.value)),
    ...subscripted.flatMap((w) => w.value.match(SUBSCRIPT_RE) ?? []),
  ];
}

function expansionTexts(value: string): string[] {
  const parts = [...value.matchAll(EXPANSION_ARITH_RE)].flatMap(([, sub, offset]) => [sub ?? "", offset ?? ""]);
  return [...(value.match(ARITH_EXPANSION_RE) ?? []), ...parts];
}

/** Operands a command reads as arithmetic; printf's values only under a numeric conversion. */
function arithArgs(name: string, args: WordToken[]): WordToken[] {
  if (name === "let") return args;
  if (name === "[[") return args.filter((_, i) => ARITH_TESTS.has(args[i - 1]?.value ?? "") || ARITH_TESTS.has(args[i + 1]?.value ?? ""));
  if (name === "printf") return printfValues(args);
  return ARITH_BUILTINS.has(name) ? args.filter((a) => !a.value.startsWith("-")) : [];
}

function printfValues(args: WordToken[]): WordToken[] {
  const rest = args[0]?.value === "-v" ? args.slice(2) : args;
  const [format, ...values] = rest;
  if (format === undefined) return [];
  return isRunTime(format) || NUMERIC_FORMAT_RE.test(format.value) ? values : [];
}

/** An unquoted heredoc expands its body, arithmetic included. */
function heredocTexts(list: readonly Token[]): string[] {
  return list.flatMap((t) => (t.type === "redirect" && t.body !== null && t.target?.quoted !== true ? expansionTexts(t.body) : []));
}
