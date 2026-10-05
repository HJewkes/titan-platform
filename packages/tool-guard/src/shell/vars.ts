import type { OpToken, Token, WordToken } from "./lexer.js";
import { caseChecked, clearCased, isCased, isCaseUnsure, isCaseUnsureLookup, markCase, markCased, markWord } from "./case-attrs.js";
import type { CaseUnsure } from "./case-attrs.js";
import { printedText } from "./printed.js";
import { commandWrites, compoundWrites, noteCompounds } from "./writers.js";

/**
 * Shell variables assigned earlier in the same command string; null means assigned but not knowable.
 * Hidden `readonly@NAME` keys, which no identifier can spell, hold `""` when NAME is surely readonly and
 * null when it may be; `readonly@*` means any variable may be. Scopes copy them along with the values.
 * Hidden `case@NAME` and `cased@NAME` keys track case attributes; see case-attrs.ts.
 */
export type Vars = Map<string, string | null>;

/**
 * `NAME=value`, `NAME+=value` or `NAME[i]=value`. An `append` depends on the earlier value; an `element`
 * write keeps its value only as `NAME[0]=literal`, the element `$NAME` reads, and persists even before a command.
 * A `hidden` write is the walk's own save or restore of a function local, which no readonly check stops.
 * `cased` marks a value copied from one a case attribute may have changed.
 */
export type Assignment = [name: string, value: string | null, kind?: "append" | "element" | "hidden", cased?: true];

/** The subscript ends at the last `]` before `=`, so a nested subscript never hides that the word assigns. */
export const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[.*\])?\+?=/s;
const ASSIGNMENT_PARTS_RE = /^([A-Za-z_][A-Za-z0-9_]*)(\[.*\])?(\+?)=/s;
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A target may carry a subscript: bash writes one element, so the whole variable is no longer what it was. */
const TARGET_RE = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[.*\])?$/s;
/** A name a declaration lists, with or without a subscript or a value. */
const DECLARED_RE = /^([A-Za-z_][A-Za-z0-9_]*)(\[.*\])?(?:\+?=|$)/s;
const ANY_READONLY = "readonly@*";
const DECLARERS = new Set(["export", "declare", "typeset", "local", "readonly"]);
/** Bash rejects a subscripted name here as no valid identifier, so the variable keeps its value. */
const SCALAR_DECLARERS = new Set(["export", "readonly"]);
/** An `r` in an option word, even one bash must still expand, may make every name the declaration lists readonly. */
const READONLY_FLAG_RE = /^-.*r/s;
/** Bash reads options only up to `--` or the first word that is none. */
const OPTION_WORD_RE = /^[-+]./s;
const DECLARE_LETTERS = new Set("airtx");
/**
 * The option letters that assign the value as written in bash 3.2 and 5 alike. Any other may assign nothing
 * (`-f` names a function, `-p` prints, bash 3.2 rejects `-g`, `-A`, `-n` and `-I`) or change the value (`-l`, `-u`).
 */
const OPTION_LETTERS: Record<string, Set<string>> = {
  declare: DECLARE_LETTERS,
  typeset: DECLARE_LETTERS,
  local: DECLARE_LETTERS,
  export: new Set("n"),
  readonly: new Set("a"),
};

export function lookup(vars: Vars, home: string | null, name: string): string | null | CaseUnsure {
  return caseChecked(vars, name, vars.has(name) ? (vars.get(name) ?? null) : name === "HOME" ? home : null);
}

/**
 * Replaces plain variable references with their literal values; any unknown reference leaves the word as it was.
 * A reference a case attribute may have changed expands as written and marks the word.
 */
export function expandWord(w: WordToken, resolve: (name: string) => string | null | CaseUnsure): WordToken {
  if (!w.dynamic || w.computed || w.refs.length === 0) return w;
  const found = w.refs.map((ref) => resolve(ref.name));
  const unsure = found.some(isCaseUnsureLookup);
  const literals = found.map((f) => (isCaseUnsureLookup(f) ? f.asWritten : f));
  let value = "";
  let last = 0;
  for (const [i, ref] of w.refs.entries()) {
    value += w.value.slice(last, ref.start) + literals[i];
    last = ref.end;
  }
  const expanded = literals.includes(null) ? w : { ...w, value: value + w.value.slice(last), dynamic: false, refs: [], typed: w.typed ?? w.value };
  const result = unsure ? markWord(expanded) : expanded;
  if (sureWords.has(w)) sureWords.add(result);
  return result;
}

/** The words of each command that surely runs once, as the builtin it names, in the current shell. */
const sureWords = new WeakSet<WordToken>();
const CLOSERS: Record<string, string> = { if: "fi", while: "done", until: "done", for: "done", select: "done", case: "esac" };
const LEADING_KEYWORDS = new Set(["then", "do", "else", "elif", "!"]);
/** Words that still run the builtin after them in the current shell; any other wrapper runs a program. */
const PASS_THROUGH = new Set(["builtin", "command", "time"]);
/** A command these lead may not run; a newline after one still continues it. */
const CONDITIONAL_OPS = new Set(["&&", "||", "|", "|&"]);
/** A command these follow runs in a subshell. */
const APART_OPS = new Set(["|", "|&", "&"]);

/** An open group or compound command, the word that closes it, and whether bash may skip or repeat what it holds. */
interface Construct {
  closer: string;
  unsure: boolean;
  start: number;
}

interface Structure {
  open: Construct[];
  prev: string | null;
  words: WordToken[];
  start: boolean;
  /** A function or `coproc` header was read, so the next group runs only when called, or apart. */
  header: boolean;
}

/**
 * Notes which commands run surely and once in the current shell. The walk is linear, so without this a
 * readonly in an untaken branch, a loop, an uncalled function, a pipeline, a background job or under a
 * wrapper such as `env` or `xargs` would be treated as certain. Returns the tokens unchanged.
 */
export function noteSureCommands(tokens: Token[]): Token[] {
  const s: Structure = { open: [], prev: null, words: [], start: true, header: false };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token;
    if (token.type === "word") i = structureWord(tokens, i, s);
    else if (token.type === "op") i = structureOp(tokens, i, s);
  }
  endCommand(s, null);
  return noteCompounds(tokens);
}

function structureWord(tokens: Token[], i: number, s: Structure): number {
  const w = tokens[i] as WordToken;
  const keyword = s.start && !w.quoted ? w.value : "";
  const closer = CLOSERS[keyword];
  if (keyword === "{") openConstruct(s, i, "}", s.header || CONDITIONAL_OPS.has(s.prev ?? ""));
  else if (closer !== undefined) {
    openConstruct(s, i, closer, true);
    s.start = closer === "fi" || keyword === "while" || keyword === "until";
  } else if (keyword !== "" && s.open.at(-1)?.closer === keyword) closeConstruct(tokens, i, s);
  else if (keyword === "coproc") return coprocHeader(tokens, i, s);
  else if (!LEADING_KEYWORDS.has(keyword)) {
    s.header ||= keyword === "function";
    s.words.push(w);
    s.start = false;
  }
  return i;
}

/** `coproc` runs its command or group apart; a name before a group is no command, so the group still opens. */
function coprocHeader(tokens: Token[], i: number, s: Structure): number {
  s.words.push(tokens[i] as WordToken);
  s.header = true;
  const [name, group] = [tokens[i + 1], tokens[i + 2]];
  const opens = group?.type === "word" ? group.value === "{" : group?.type === "op" && group.value === "(";
  if (name?.type !== "word" || !IDENTIFIER_RE.test(name.value) || !opens) return i;
  s.words.push(name);
  return i + 1;
}

/** A `( )` pair after a name is a function header; any other `(` opens a subshell group. */
function structureOp(tokens: Token[], i: number, s: Structure): number {
  const op = (tokens[i] as OpToken).value;
  const next = tokens[i + 1];
  if (op === "\n" && s.words.length === 0 && CONDITIONAL_OPS.has(s.prev ?? "")) return i;
  endCommand(s, op);
  if (op === "(" && next?.type === "op" && next.value === ")") {
    [s.header, s.start] = [true, true];
    return i + 1;
  }
  if (op === "(") openConstruct(s, i, ")", s.header || CONDITIONAL_OPS.has(s.prev ?? ""));
  if (op === ")" && s.open.at(-1)?.closer === ")") closeConstruct(tokens, i, s);
  s.prev = op;
  s.start = true;
  return i;
}

function openConstruct(s: Structure, i: number, closer: string, unsure: boolean): void {
  s.open.push({ closer, unsure, start: i });
  s.header = false;
}

/** A construct piped or sent to the background runs in a subshell, so nothing in it is sure. */
function closeConstruct(tokens: Token[], i: number, s: Structure): void {
  const construct = s.open.pop() as Construct;
  s.start = false;
  const next = tokens.slice(i + 1).find((t) => t.type !== "redirect");
  if (next?.type !== "op" || !APART_OPS.has(next.value)) return;
  for (const t of tokens.slice(construct.start, i)) if (t.type === "word") sureWords.delete(t);
}

function endCommand(s: Structure, op: string | null): void {
  const apart = op !== null && APART_OPS.has(op);
  const unsure = apart || CONDITIONAL_OPS.has(s.prev ?? "") || s.open.some((c) => c.unsure);
  if (!unsure && runsDeclarer(s.words)) for (const w of s.words) sureWords.add(w);
  s.words = [];
}

/** The command word, past assignments, `builtin`, `command` and `time -p`, is a declaration builtin. */
function runsDeclarer(words: WordToken[]): boolean {
  const name = words.find((w) => !ASSIGNMENT_RE.test(w.value) && !PASS_THROUGH.has(w.value) && w.value !== "-p");
  return name !== undefined && !name.dynamic && DECLARERS.has(name.value);
}

/** `NAME=value` or `NAME+=value` split into its name and value, the value null when it is only known at run time. */
export function parseAssignment(w: WordToken): Assignment | null {
  const parsed = splitAssignment(w);
  return parsed && isCaseUnsure(w) ? [parsed[0], parsed[1], parsed[2], true] : parsed;
}

function splitAssignment(w: WordToken): Assignment | null {
  if (w.hidden) {
    const eq = w.value.indexOf("=");
    return [w.value.slice(0, eq), w.dynamic ? null : w.value.slice(eq + 1), "hidden"];
  }
  const parts = ASSIGNMENT_PARTS_RE.exec(w.value);
  if (!parts) return null;
  const [whole, name = "", subscript, plus] = parts;
  const value = w.dynamic ? null : w.value.slice(whole.length);
  if (subscript !== undefined) return [name, subscript === "[0]" && !plus ? value : null, "element"];
  return plus ? [name, value, "append"] : [name, value];
}

/** Records an assignment; an append is literal only when both the earlier value and the appended part are. */
export function assign(vars: Vars, [name, value, kind, cased]: Assignment): void {
  const priorCased = isCased(vars, name);
  if (kind === "hidden") restore(vars, name, value);
  else if (kind !== "append") write(vars, name, value);
  else {
    const prior = vars.get(name) ?? null;
    write(vars, name, prior !== null && value !== null ? prior + value : null);
  }
  markCased(vars, name, cased || (kind === "append" && priorCased));
}

/** A copy for a new shell: `eval` keeps every readonly variable and a child shell drops them, so each only may be. */
export function childVars(vars: Vars): Vars {
  const copy = new Map(vars);
  for (const key of copy.keys()) if (key.startsWith("readonly@")) copy.set(key, null);
  return copy;
}

const readonlyKey = (name: string) => `readonly@${name}`;

/** Bash rejects a write to a readonly variable, so it keeps its value; one that may be readonly becomes unknown. */
function write(vars: Vars, name: string, value: string | null): void {
  const flag = vars.get(readonlyKey(name));
  if (flag === "") return;
  clearCased(vars, name);
  vars.set(name, flag === null || vars.has(ANY_READONLY) ? null : value);
}

/** A function's return restores a local's outer value, which may or may not have been readonly. */
function restore(vars: Vars, name: string, value: string | null): void {
  clearCased(vars, name);
  vars.set(name, value);
  if (vars.has(readonlyKey(name))) vars.set(readonlyKey(name), null);
}

/**
 * Applies the effect a command has on shell variables: declarations, `printf -v` and `let` set them, `read` and
 * friends make them unknowable, and so does an element write before it, which bash may keep once it ends.
 */
export function trackVars({ name, args, assigned }: TrackedCommand, vars: Vars): void {
  if (name === null) return;
  for (const [target, , kind] of assigned) if (kind === "element") write(vars, target, null);
  if (DECLARERS.has(name)) return trackDeclaration(name, args, vars);
  if (name === "printf") printfVar(args, vars);
  writeEach(vars, commandWrites(name, args));
}

/** `(( ))` writes in the current shell, though the walk reads its parentheses as a subshell. */
export function trackCompound(op: Token, vars: Vars): void {
  writeEach(vars, compoundWrites(op, (w) => expandWord(w, (name) => lookup(vars, null, name))));
}

/** A null list means the command may write any variable. */
function writeEach(vars: Vars, writes: Assignment[] | null): void {
  if (!writes) return forgetAll(vars);
  for (const [target, value] of writes) write(vars, target, value);
}

/**
 * Each write lands first and the names become readonly after it. A word known only at run time may be
 * `-r` and any name, so from then on any variable may be readonly.
 */
function trackDeclaration(name: string, args: WordToken[], vars: Vars): void {
  const end = args.findIndex((a) => a.dynamic || a.value === "--" || !OPTION_WORD_RE.test(a.value));
  const options = end < 0 ? args : args.slice(0, end);
  const readonly = name === "readonly" || (name !== "export" && options.some((a) => READONLY_FLAG_RE.test(a.value)));
  const mode: ReadonlyMode = !readonly ? null : options.some((a) => a.value.includes("a")) ? "array" : "scalar";
  for (const arg of args) declareArg(name, parseAssignment(arg), mode, vars);
  const sure = name !== "local" && args.every((a) => sureWords.has(a));
  if (readonly) for (const arg of args) markReadonly(name, arg, sure, vars);
  if (args.some((a) => unreadableDeclareWord(name, a))) forgetAll(vars);
  const letters = [..."lu"].filter((c) => options.some((a) => a.value.includes(c))).join("");
  if (letters) for (const arg of args) markCase(vars, DECLARED_RE.exec(arg.value)?.[1], letters);
  if (args.some((a) => a.dynamic && parseAssignment(a) === null)) vars.set(ANY_READONLY, null);
}

/** A word known only at run time may be any assignment; an option outside the stable set may leave any unmade or changed. */
function unreadableDeclareWord(name: string, arg: WordToken): boolean {
  if (arg.dynamic) return parseAssignment(arg) === null;
  const v = arg.value;
  if (v === "--" || !(v.startsWith("-") || v.startsWith("+"))) return false;
  const letters = [...v.slice(1)];
  return letters.length === 0 || letters.some((c) => !OPTION_LETTERS[name]?.has(c));
}

/** Nulls every tracked variable, `HOME` included, after a declaration this walk cannot read. */
function forgetAll(vars: Vars): void {
  for (const key of vars.keys()) vars.set(key, null);
  vars.set("HOME", null);
}

/** How a declaration makes its names readonly; null when it does not. */
type ReadonlyMode = "scalar" | "array" | null;

/**
 * `export` and `readonly` reject an element name. Whether a readonly element write lands differs across bash
 * versions, and so does a readonly array assignment, which bash 3.2 rejects; either leaves the value unknown.
 */
function declareArg(name: string, assignment: Assignment | null, mode: ReadonlyMode, vars: Vars): void {
  if (!assignment) return;
  const [target, value, kind, cased] = assignment;
  if (kind === "element") {
    if (!SCALAR_DECLARERS.has(name)) write(vars, target, mode ? null : value);
  } else if (mode === "array") write(vars, target, null);
  else return assign(vars, assignment);
  markCased(vars, target, cased);
}

/**
 * Marks the variable a declaration word names, plain or with a subscript `readonly` rejects. Only a declaration
 * that surely runs once in this shell makes it surely readonly. A `local` is in a function body, which runs only
 * when called, or else at the top level, where bash rejects it; either way it only may be readonly.
 */
function markReadonly(name: string, arg: WordToken, sure: boolean, vars: Vars): void {
  const [, variable, subscript] = DECLARED_RE.exec(arg.value) ?? [];
  if (!variable || (subscript !== undefined && SCALAR_DECLARERS.has(name))) return;
  const key = readonlyKey(variable);
  if (sure || vars.get(key) !== "") vars.set(key, sure ? "" : null);
}

interface TrackedCommand {
  name: string | null;
  args: WordToken[];
  assigned: Assignment[];
}

/** `printf -v NAME` or `printf -vNAME` stores the text it would print; only a first word is an option, so `printf -- -vX` sets nothing. */
function printfVar(args: WordToken[], vars: Vars): void {
  const first = args[0]?.value;
  if (first === undefined || !first.startsWith("-v")) return;
  const attached = first.slice(2);
  const target = attached || args[1]?.value;
  const base = target === undefined ? undefined : TARGET_RE.exec(target);
  if (!base) return;
  const subscripted = base[0] !== base[1];
  write(vars, base[1] as string, subscripted ? null : printedText("printf", args.slice(attached ? 1 : 2)));
  markCased(vars, base[1] as string, args.some(isCaseUnsure));
}
