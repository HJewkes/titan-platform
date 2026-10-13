import { DECLARERS, nameSlots, NAMEREF_DECLARERS } from "./name-slots.js";
import type { Token, WordToken } from "./tokens.js";
import { ASSIGNMENT_RE } from "./vars.js";

/** Builtins that evaluate an argument as shell or arithmetic text, so a run-time argument may assign any name. */
const EVALUATORS = new Set(["eval", "let", "trap"]);
/** Builtins that run a callback over input text: `mapfile -C` evaluates it with each line appended. */
const CALLBACK_RUNNERS = new Set(["mapfile", "readarray"]);
/** zsh declarers whose names always hold numbers, so every later write to them is arithmetic. */
const NUMERIC_DECLARERS = new Set(["integer", "float"]);
/** Builtins that run a file's text in this shell, which may assign anything. */
const SOURCERS = new Set(["source", "."]);
/** Words that may precede the command word without being it. */
const COMMAND_PREFIXES = new Set(["{", "}", "!", "do", "then", "else", "elif", "if", "while", "until", "time", "done", "fi", "builtin", "command"]);
const NAME_BUILDER_RE = /[$`?*[]/;
/** A command word bash may glob or brace-expand into any builtin. */
const COMMAND_BUILDER_RE = /[?*[{]/;
/** The test commands, whose brackets are their names rather than globs. */
const TEST_COMMANDS = new Set(["[", "[["]);
/** `[[` compares these operands as arithmetic, which assigns any `NAME=` text it is given. */
const ARITH_TESTS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);
/**
 * Arithmetic contexts in a word's text holding run-time text: `$(( ))`, a `${x:offset}` substring and an indexed
 * subscript, and an indirect `${!x}`, whose target's subscript bash evaluates. bash expands that text first, so
 * `$a$b=1` there assigns whatever name it builds.
 */
const RUN_TIME_ARITH_RES = [/\$\(\([^]*[$`]/, /\$\{[^}:]*:(?![-=+?])[^}]*[$`]/, /\[[^\]]*[$`]/, /\$\{!/];

/** A command segment and whether it sits inside `(( ))`, where any run-time word is arithmetic text. */
interface Segment {
  words: WordToken[];
  arith: boolean;
}

/**
 * Whether any command in the tokens may write a variable whose name only exists at run time: a write slot whose
 * name part holds an expansion, a command substitution or a glob, a nameref to such a name, run-time arithmetic,
 * an evaluator given run-time text, a sourced file, or a command word that may become any of those builtins.
 * The model answers true wherever it cannot read the name.
 */
export function mayWriteRunTimeName(tokens: readonly Token[]): boolean {
  return segments(tokens).some(segmentMayWrite);
}

function segments(tokens: readonly Token[]): Segment[] {
  const out: Segment[] = [];
  let words: WordToken[] = [];
  let arith = false;
  let afterOpen = false;
  for (const t of tokens) {
    if (t.type === "word") words.push(t);
    if (t.type !== "op") continue;
    out.push({ words, arith });
    words = [];
    if (t.value === ")") arith = false;
    else if (t.value === "(" && afterOpen) arith = true;
    afterOpen = t.value === "(";
  }
  out.push({ words, arith });
  return out;
}

function segmentMayWrite({ words, arith }: Segment): boolean {
  if (arith) return words.some(isRunTime);
  if (words.some(holdsRunTimeArith)) return true;
  const { command, args } = splitCommand(words);
  return command ? commandMayWrite(command, args) : false;
}

function splitCommand(words: WordToken[]): { command?: WordToken; args: WordToken[] } {
  const at = words.findIndex((w) => !COMMAND_PREFIXES.has(w.value) && !ASSIGNMENT_RE.test(w.value) && !isOption(w));
  return at < 0 ? { args: [] } : { command: words[at], args: words.slice(at + 1) };
}

/**
 * A command word that is not a static literal may become any builtin, `source` and `declare -n` included, so it
 * answers true whatever its arguments look like.
 */
function commandMayWrite(command: WordToken, args: WordToken[]): boolean {
  const name = command.value;
  if (name === "[[") return args.some((a) => ARITH_TESTS.has(a.value)) && args.some(isRunTime);
  if (isRunTime(command) || (!TEST_COMMANDS.has(name) && COMMAND_BUILDER_RE.test(name))) return true;
  if (SOURCERS.has(name) || runsCode(name, args)) return true;
  const slots = nameSlots(name, args);
  if (typeof slots === "string") return true;
  return slots.some(nameMayBeRunTime) || namerefMayBeRunTime(name, args);
}

/**
 * Evaluator sinks: run-time text given to eval, let or trap, a mapfile callback, and an integer or zsh float
 * (`-E`, `-F`) attribute, under which a later `x=$v` or `read x` evaluates the value as arithmetic and `IFS=1`
 * there assigns IFS. bash's `declare -F` only lists functions, which errs toward true.
 */
function runsCode(name: string, args: WordToken[]): boolean {
  if (EVALUATORS.has(name)) return args.some(isRunTime);
  if (NUMERIC_DECLARERS.has(name)) return true;
  if (CALLBACK_RUNNERS.has(name)) return args.some((a) => mayBeOptionWord(a) && (isRunTime(a) || /^-[A-Za-z0-9]*C/.test(a.value)));
  return DECLARERS.has(name) && args.some((a) => mayBeOptionWord(a) && (isRunTime(a) || /^[-+][A-Za-z0-9]*[iEF]/.test(a.value)));
}

/**
 * Under `-n` an operand's target is the name later writes through it reach: a run-time target may be IFS, and a
 * bare nameref is bound by its first assignment. A run-time option word may be `-n`.
 */
function namerefMayBeRunTime(name: string, args: WordToken[]): boolean {
  if (!NAMEREF_DECLARERS.has(name)) return false;
  const options = args.filter(mayBeOptionWord);
  if (!options.some((a) => isRunTime(a) || /^-[A-Za-z0-9]*n/.test(a.value))) return false;
  return args.filter((a) => !options.includes(a)).some((a) => !a.value.includes("=") || isRunTime(a));
}

/** A literal `-` or `+` cluster, or a run-time word that opens with an expansion and may expand to one. */
function mayBeOptionWord(w: WordToken): boolean {
  if (/^[-+]/.test(w.value)) return true;
  return isRunTime(w) && (/^[$`]/.test(w.value) || (w.cuts ?? []).some((c) => c.at === 0));
}

/**
 * The name part ends at a literal `NAME[` or `NAME=`; an expansion, a cut command substitution, a backquote or a
 * glob inside it lets bash build any name, IFS included. A literal name that spells IFS is matched elsewhere.
 */
function nameMayBeRunTime(w: WordToken): boolean {
  const literal = /^[A-Za-z_][A-Za-z0-9_]*/.exec(w.value)?.[0] ?? "";
  const eq = w.value.indexOf("=");
  const end = ASSIGNMENT_RE.test(w.value) ? literal.length : eq < 0 ? w.value.length : eq;
  return NAME_BUILDER_RE.test(w.value.slice(0, end)) || w.refs.some((r) => r.start < end) || (w.cuts ?? []).some((c) => c.at <= end);
}

function holdsRunTimeArith(w: WordToken): boolean {
  return isRunTime(w) && RUN_TIME_ARITH_RES.some((re) => re.test(w.value));
}

function isRunTime(w: WordToken): boolean {
  return w.dynamic || w.computed;
}

function isOption(w: WordToken): boolean {
  return !isRunTime(w) && /^[-+]./s.test(w.value);
}
