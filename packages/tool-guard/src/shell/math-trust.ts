import { arrayElements } from "./declarations.js";
import { expandedTexts, isRunTime, nameMayBeRunTime, segments, splitCommand, TESTS } from "./ifs-writes.js";
import type { Segment } from "./ifs-writes.js";
import { DECLARERS, NAMEREF_DECLARERS, nameSlots, WRITERS } from "./name-slots.js";
import { numericOutput } from "./numeric-output.js";
import { onPathLine } from "./path-commands.js";
import { tokenize } from "./lexer.js";
import type { Token, WordToken } from "./tokens.js";
import { ASSIGNMENT_RE } from "./vars.js";
import type { Vars } from "./vars.js";
import { expansionBodies, writtenNames } from "./writers.js";

/**
 * Hidden key holding the text of every write a line makes to NAME, joined, wherever on the line it sits: math reads
 * a name in a loop or a function body after a write that comes later in the text. Null when one write is unknown,
 * `""` for a number. No identifier can spell these keys, and scopes copy them with the values.
 */
export const writtenKey = (name: string) => `wrote@${name}`;
/** Separates the texts of a name's writes in its key: each is read on its own. */
export const VALUE_SEPARATOR = "\0";
/** The line runs text that may write any name: `eval`, `source`, `trap`, a run-time command word or name, a nameref. */
export const ANY_WRITE = "wrote@*";
/** The positional parameters may hold text the line chose: `set --`, a call of its own function with a word that is not digits, a shell's arguments. */
export const POSITIONALS_SET = "wrote@positional";
/** A name this text never writes holds whatever started it: the Bash tool's environment on the line, the line's own choice in a script it runs. */
export const ENVIRONMENT_UNKNOWN = "wrote@environment";
/** Something may rebind a command whose output reads as digits (`date() { … }`), so a substitution's output is unknown. */
export const NOT_PATH_LINE = "wrote@path";

/** Builtins that run text the walk does not read in this shell, which may write any name. */
const UNSEEN_WRITERS = new Set(["source", ".", "fc", "emulate"]);
/** Builtins that run their literal text in this shell, now or on a signal, so its writes are the line's. */
const TEXT_RUNNERS = new Set(["eval", "trap"]);
/** How deep `eval` text inside `eval` text is read before it counts as unreadable. */
const MAX_TEXT_DEPTH = 4;
/** Commands that pass `NAME=value` arguments into the environment of what they run, a nested shell among them. */
const ENVIRONMENT_SETTERS = new Set(["env", "sudo", "doas"]);
/** Names whose file a shell runs as it starts, so setting one may write any name in a nested shell. */
const STARTUP_FILES = ["BASH_ENV", "ENV", "ZDOTDIR"];
/** `unset` empties a name and zsh's `shift NAME` drops elements, so neither stores text math could read. */
const VALUE_DROPPERS = new Set(["unset", "shift"]);
/** A `${N=…}`, `${N:=…}` or zsh `${N::=…}`, which assigns N. */
const DEFAULT_ASSIGN_RE = /\$\{[#+^=~]*([A-Za-z_]\w*)(?:\[[^\]]*\])*:{0,2}=/g;
/** bash's `${!n=…}` and zsh's `${(P)n::=…}` assign whatever name n holds. */
const INDIRECT_ASSIGN_RE = /\$\{[#+^=~]*[!(][^}]*=/;
/** zsh assigns the positional parameters through `argv` and by number: `argv=(x)`, `1=x`. */
const POSITIONAL_WRITE_RE = /^(?:argv|\d+)(?:\[.*\])?\+?=/s;
/** A word that may expand to an option, such as a declarer's `-n`. */
const OPTION_LIKE_RE = /^[$`-]/;

type Writes = Map<string, Array<string | null>>;

/** The writes read so far, whether a substitution's output may be read as digits, and how deep in `eval` text. */
interface Reading {
  writes: Writes;
  pathLine: boolean;
  depth: number;
}

/**
 * Notes, before a token list is walked, everything math needs from the whole of it: each name's writes, whether
 * something may write any name or set the positional parameters, and whether a command it runs may be rebound.
 */
export function noteLineWrites(tokens: Token[], vars: Vars): void {
  const words = tokens.filter((t): t is WordToken => t.type === "word");
  if (words.length > 0 && !words.some(onPathLine)) vars.set(NOT_PATH_LINE, null);
  if (positionalsMaySet(tokens)) vars.set(POSITIONALS_SET, null);
  const r: Reading = { writes: new Map(), pathLine: !vars.has(NOT_PATH_LINE), depth: 0 };
  if (recordList(tokens, r) || STARTUP_FILES.some((name) => r.writes.has(name))) vars.set(ANY_WRITE, null);
  for (const [name, texts] of r.writes) {
    const key = writtenKey(name);
    const all = vars.has(key) ? [vars.get(key) ?? null, ...texts] : texts;
    vars.set(key, all.includes(null) ? null : all.join(VALUE_SEPARATOR));
  }
}

/** Records every segment's writes; true, and done, once one may write a name the model cannot read. */
const recordList = (tokens: Token[], r: Reading) => segments(tokens).some((segment) => recordSegment(segment, r));

function record({ writes }: Reading, name: string, text: string | null): void {
  const texts = writes.get(name);
  if (texts) texts.push(text);
  else writes.set(name, [text]);
}

function recordSegment(segment: Segment, r: Reading): boolean {
  if (segment.arith) {
    for (const name of writtenNames([...segment.words.map((w) => w.value), ...segment.redirects].join(" "))) record(r, name, "");
    return false;
  }
  const texts = expandedTexts(segment);
  for (const name of texts.flatMap(expansionBodies).flatMap(writtenNames)) record(r, name, "");
  for (const text of texts) for (const [, name = ""] of text.matchAll(DEFAULT_ASSIGN_RE)) record(r, name, null);
  const words = visible(segment.words);
  const { command, args } = splitCommand(words);
  const leading = command ? words.slice(0, words.indexOf(command)) : words;
  for (const w of leading) if (ASSIGNMENT_RE.test(w.value)) record(r, nameOf(w), valueText(w, r.pathLine));
  if (texts.some((text) => INDIRECT_ASSIGN_RE.test(text))) return true;
  return command !== undefined && commandWrites(command, args, r);
}

const nameOf = (w: WordToken) => /^[A-Za-z_]\w*/.exec(w.value)?.[0] ?? "";

/**
 * The walk's own save and restore of a function local copy a value the line already wrote, so they are no writes of
 * their own; a `{name}` before a redirect is its descriptor, or a word `exec` runs as a program, which writes no name.
 */
const visible = (words: WordToken[]) => words.filter((w) => !w.hidden && w.namedFd === undefined);

/** Records what a command writes; true when it may write a name it does not spell, or runs text that may. */
function commandWrites(command: WordToken, args: WordToken[], r: Reading): boolean {
  const name = command.value;
  if (TESTS.has(name) || VALUE_DROPPERS.has(name)) return false;
  if (isRunTime(command) || /[?*[{]/.test(name) || UNSEEN_WRITERS.has(name)) return true;
  if (TEXT_RUNNERS.has(name)) return textWrites(name === "trap" ? args.slice(0, 1).filter((a) => !a.value.startsWith("-")) : args, r);
  if (name === "let") for (const text of args.map((a) => a.value).flatMap(writtenNames)) record(r, text, "");
  if (name === "getopts") record(r, "OPTIND", "");
  if (ENVIRONMENT_SETTERS.has(name)) return environmentWrites(args, r);
  if (name === "for" || name === "select") return loopWrites(args, r);
  if (!WRITERS.has(name)) return false;
  if (NAMEREF_DECLARERS.has(name) && args.some((a) => /^-[A-Za-z0-9]*n/.test(a.value) || (isRunTime(a) && OPTION_LIKE_RE.test(a.value)))) return true;
  if ((name === "mapfile" || name === "readarray") && args.some((a) => /^-[A-Za-z0-9]*C/.test(a.value))) return true;
  const slots = nameSlots(name, args);
  if (typeof slots === "string" || slots.some(nameMayBeRunTime)) return true;
  const declared = DECLARERS.has(name);
  const integer = name === "integer" || name === "float" || (declared && args.some((a) => /^-[A-Za-z0-9]*[iEF]/.test(a.value)));
  for (const slot of slots) {
    if (declared && !slot.value.includes("=")) continue;
    record(r, nameOf(slot), !declared ? null : integer ? "" : valueText(slot, r.pathLine));
  }
  return false;
}

/**
 * `env NAME=value cmd` sets NAME for cmd alone, which a nested shell reads. Every assignment-shaped argument counts,
 * even one a later wrapper or the command itself reads (`sudo env e=x sh`); `env -S` splits text into more of them.
 */
function environmentWrites(args: WordToken[], r: Reading): boolean {
  for (const arg of args) if (ASSIGNMENT_RE.test(arg.value)) record(r, nameOf(arg), valueText(arg, r.pathLine));
  return args.some((a) => /^-[A-Za-z]*S|^--split-string/.test(a.value));
}

/**
 * `eval` and `trap` text the line types runs in this shell, so its writes are read as the line's. Run-time text, text
 * the lexer cannot read, text nested too deep, or text that may set the positional parameters may write anything.
 */
function textWrites(args: WordToken[], r: Reading): boolean {
  if (args.length === 0) return false;
  if (r.depth >= MAX_TEXT_DEPTH || args.some(isRunTime)) return true;
  let tokens: Token[];
  try {
    tokens = tokenize(args.map((a) => a.value).join(" "));
  } catch {
    return true;
  }
  return positionalsMaySet(tokens) || recordList(tokens, { ...r, pathLine: false, depth: r.depth + 1 });
}

/** `for NAME in WORDS`: digits and numeric substitutions write numbers, other literal words their text; no list means the positional parameters. */
function loopWrites(args: WordToken[], r: Reading): boolean {
  const [variable, keyword, ...list] = args;
  if (variable === undefined || !/^[A-Za-z_]\w*$/.test(variable.value)) return false;
  if (keyword?.value !== "in" || keyword.quoted) record(r, variable.value, null);
  else for (const word of list) record(r, variable.value, valueText(word, r.pathLine, 0));
  return false;
}

/**
 * The text a write stores, as math will later read it: literal digits and a whole `$(( ))` are numbers, a substitution
 * whose output is digits reads as `0`, and `$name` pieces are kept for the reader to follow. Null when unknown.
 */
function valueText(w: WordToken, pathLine: boolean, at = ASSIGNMENT_RE.exec(w.value)?.[0].length ?? 0): string | null {
  const elements = arrayElements.get(w);
  if (elements) return elements.some(isRunTime) ? null : elements.map((e) => e.value).join(" ");
  if (!isRunTime(w)) return /^\d+$/.test(w.value.slice(at)) ? "" : w.value.slice(at);
  const cuts = w.cuts ?? [];
  if (cuts.some((cut) => !pathLine || !numericOutput(w.subs[cut.sub] ?? []))) return null;
  let text = w.value;
  for (const cut of [...cuts].sort((x, y) => y.at - x.at)) text = `${text.slice(0, cut.at)}0${text.slice(cut.at)}`;
  const value = text.slice(at);
  return wholeArithmetic(value) ? "" : value;
}

/** A value that is one `$(( ))` and nothing after it, which stores a number. */
function wholeArithmetic(value: string): boolean {
  if (!value.startsWith("$((")) return false;
  let depth = 0;
  for (let i = 1; i < value.length; i++) {
    depth += value[i] === "(" ? 1 : value[i] === ")" ? -1 : 0;
    if (depth === 0) return i === value.length - 1;
  }
  return false;
}

/**
 * Whether the positional parameters may hold text the line chose, anywhere in it or its substitutions: `set` with an
 * operand, a zsh write to `argv` or a number, or a function the line defines called with a word that is not digits,
 * or where a call cannot be seen: a run-time command word, `eval` or `trap` text.
 */
function positionalsMaySet(tokens: Token[]): boolean {
  const lists = withNested(tokens);
  const all = lists.flatMap((list) => segments(list));
  const commands = all.map((s) => splitCommand(visible(s.words)));
  if (commands.some(({ command, args }) => command?.value === "set" && setsPositionals(args))) return true;
  if (all.some((s) => visible(s.words).some((w) => POSITIONAL_WRITE_RE.test(w.value)))) return true;
  const defined = lists.flatMap(definedFunctions);
  if (defined.length === 0) return false;
  if (defined.includes(null) || commands.some(({ command }) => command !== undefined && (isRunTime(command) || TEXT_RUNNERS.has(command.value)))) return true;
  const functions = new Set(defined);
  return all.some((s) => callsWithText(s.words, functions));
}

/** Whether a word names one of the functions with a word after it that is not digits; one pass from the end. */
function callsWithText(words: WordToken[], functions: ReadonlySet<string | null>): boolean {
  let digitsAfter = true;
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i];
    if (w === undefined) continue;
    if (!digitsAfter && functions.has(w.value) && words[i - 1]?.value !== "function") return true;
    digitsAfter &&= !isRunTime(w) && /^\d+$/.test(w.value);
  }
  return false;
}


/** `set` with any operand, `--` or `-` included, sets them; option clusters and `-o NAME` do not. */
function setsPositionals(args: WordToken[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined || isRunTime(a) || !/^[-+][A-Za-z]+$/.test(a.value)) return true;
    if (a.value.endsWith("o")) i++;
  }
  return false;
}

/** The names of the functions a list defines; null for one whose name the walk cannot read. */
function definedFunctions(tokens: Token[]): Array<string | null> {
  return tokens.flatMap((t, i) => {
    if (t.type !== "word") return [];
    const header = isOp(tokens[i + 1], "(") && isOp(tokens[i + 2], ")");
    const before = tokens[i - 1];
    const keyword = before?.type === "word" && before.value === "function";
    if (!header && !keyword) return [];
    return [isRunTime(t) || t.quoted ? null : t.value];
  });
}

const isOp = (t: Token | undefined, value: string) => t?.type === "op" && t.value === value;

/** The list and every substitution's list inside it, however deep. */
function withNested(tokens: Token[]): Token[][] {
  const out: Token[][] = [];
  const pending = [tokens];
  for (let list = pending.pop(); list !== undefined; list = pending.pop()) {
    out.push(list);
    for (const t of list) {
      if (t.type === "word" || t.type === "subs") pending.push(...t.subs);
      if (t.type === "redirect") pending.push(...t.subs, ...(t.target?.subs ?? []));
    }
  }
  return out;
}
