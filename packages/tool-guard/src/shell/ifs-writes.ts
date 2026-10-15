import { ARITH_BUILTINS, INERT_BUILTINS, SHELL_BUILTINS } from "./builtins.js";
import { DECLARERS, nameSlots, NAMEREF_DECLARERS, WRITERS } from "./name-slots.js";
import type { RedirectToken, Token, WordToken } from "./tokens.js";
import { ASSIGNMENT_RE } from "./vars.js";

/** Builtins that evaluate an argument as shell or arithmetic text, so a run-time argument may assign any name. */
const EVALUATORS = new Set(["eval", "let", "trap"]);
/** Builtins that run a callback over input text: `mapfile -C` evaluates it with each line appended. */
const CALLBACK_RUNNERS = new Set(["mapfile", "readarray"]);
/** zsh declarers whose names always hold numbers, so every later write to them is arithmetic. */
const NUMERIC_DECLARERS = new Set(["integer", "float"]);
/** Builtins that run a file's text in this shell, which may assign anything. */
const SOURCERS = new Set(["source", "."]);
/**
 * Words that may precede the command word without being it: reserved words, and the precommand modifiers of bash
 * and zsh. A command `exec` or `coproc` runs may only write a shell that is gone, which reading it errs past.
 */
const COMMAND_PREFIXES = new Set([
  ...["{", "}", "!", "do", "then", "else", "elif", "if", "while", "until", "time", "done", "fi", "end"],
  ...["builtin", "command", "exec", "coproc", "noglob", "nocorrect", "-"],
]);
/** Builtins this model reads; any other builtin may write a name it cannot see. */
const MODELED = new Set([
  ...[...COMMAND_PREFIXES, ...WRITERS, ...EVALUATORS, ...CALLBACK_RUNNERS, ...NUMERIC_DECLARERS, ...SOURCERS],
  ...[...INERT_BUILTINS, ...ARITH_BUILTINS, "[[", "function"],
]);
const NAME_BUILDER_RE = /[$`?*[]/;
/** A command word bash may glob or brace-expand into any builtin. */
const COMMAND_BUILDER_RE = /[?*[{]/;
/** The test commands; the brackets are their names rather than globs. */
export const TESTS = new Set(["[", "[[", "test"]);
/** Reserved words after which bash and zsh still read a keyword such as `[[`. */
const CONDITIONAL_OPENERS = new Set(["!", "{", "if", "then", "elif", "else", "while", "until", "do", "time", "coproc"]);
/** `[[` compares these operands as arithmetic, which assigns any `NAME=` text it is given. */
const ARITH_TESTS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);
/**
 * Run-time text bash or zsh evaluates or assigns through: arithmetic contexts (`$(( ))`, a `${x:offset}` substring,
 * an indexed subscript), where `$a$b=1` assigns whatever name it builds, and a parameter expansion whose name the
 * model cannot read, after any zsh `=`, `~`, `^`, `#` or `+` prefix: bash's indirect `${!x}` and any zsh flag
 * group, such as `${(P)x::=,}`, which assigns the variable x names, or `(e)`, which evaluates the value. Flag
 * groups are not parsed (tool-guard's hooked-params reads their delimiters for PS4); any group answers true.
 */
const RUN_TIME_WRITE_RES = [/\$\(\([^]*[$`]/, /\$\{[^}:]*:(?![-=+?])[^}]*[$`]/, /\[[^\]]*[$`]/, /\$\{[=~^#+]*[!(]/];

/** zsh's unbraced `$+name`, `$^name`, `$=name` and `$~name`, which bash's lexer leaves as literal text. */
const ZSH_FLAGGED_RE = /\$[#+^=~]*[+^=~](?:[A-Za-z_]\w*|[@*#?$!-]|\d+)/;

type Conditional = "none" | "test" | "both";

/**
 * A command segment and whether it sits inside `(( ))`, where any run-time word is arithmetic text, as are the
 * operators and operands the lexer reads there as redirects (`i < n`). `targets` are the redirect and here-string
 * words the shell expands, heredoc delimiters aside; `bodies` are the heredoc bodies it expands, `<<-` included.
 */
export interface Segment {
  words: WordToken[];
  arith: boolean;
  /**
   * The segment starts after an `&&`, `||`, `!` or paren inside an open `[[ ]]`: `test` when its words are test
   * operands, `both` when that `[[` may also be a command, so they are read both ways.
   */
  conditional: Conditional;
  redirects: string[];
  targets: WordToken[];
  bodies: string[];
}

/**
 * Every text of the segment the shell expands at run time: run-time words and redirect or here-string targets, and
 * unquoted heredoc bodies. A quoted `'$((x))'` or `<<'E'` body evaluates nothing. bash's lexer reads zsh's
 * `$+arr[x]` as literal text, so a word holding one counts whatever its quoting. Every scan for run-time writes,
 * arithmetic and default assignments reads expanded text through this one function.
 */
export function expandedTexts({ words, targets, bodies }: Segment): string[] {
  const expanded = [...words, ...targets].filter((w) => isRunTime(w) || ZSH_FLAGGED_RE.test(w.value));
  return [...expanded.map((w) => w.value), ...bodies];
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

export function segments(tokens: readonly Token[]): Segment[] {
  const out: Segment[] = [];
  let segment: Segment = { words: [], arith: false, conditional: "none", redirects: [], targets: [], bodies: [] };
  let afterOpen = false;
  let inConditional: Conditional = "none";
  for (const t of tokens) {
    if (t.type === "word") segment.words.push(t);
    if (t.type === "word" && !t.quoted) inConditional = conditionalAfter(t, segment, inConditional);
    if (t.type === "redirect") addRedirect(segment, t);
    if (t.type !== "op") continue;
    out.push(segment);
    const arith = t.value === ")" ? false : t.value === "(" && afterOpen ? true : segment.arith;
    segment = { words: [], arith, conditional: inConditional, redirects: [], targets: [], bodies: [] };
    afterOpen = t.value === "(";
  }
  out.push(segment);
  return out;
}

/**
 * `[[` is a keyword only at a command's start or after reserved words, so only there does it open a conditional.
 * After a precommand modifier (`command`, `builtin`, `noglob`, `-`) or an assignment it is an ordinary word, and
 * the segments after it are commands; its own operands still read as arithmetic through `splitCommand`. bash's
 * `time -p [[` is a conditional, but zsh's `time` takes no options and runs `-p` as the command, so after `time`
 * and option-like words the segments after it are read both ways.
 */
function conditionalAfter(word: WordToken, segment: Segment, open: Conditional): Conditional {
  if (word.value === "]]") return "none";
  if (word.value !== "[[" || open !== "none") return open;
  const before = segment.words.slice(0, segment.words.indexOf(word));
  if (keywordPosition(before)) return "test";
  return timedWithOptions(before) ? "both" : "none";
}

/** Every word before the `[[` is a reserved word. */
function keywordPosition(before: WordToken[]): boolean {
  return before.every((w) => !w.quoted && CONDITIONAL_OPENERS.has(w.value));
}

/** Reserved words, then `time`, then only option-like words (`time -p --`). */
function timedWithOptions(before: WordToken[]): boolean {
  const at = before.map((w) => !w.quoted && w.value === "time").lastIndexOf(true);
  const options = before.slice(at + 1);
  return at >= 0 && options.length > 0 && keywordPosition(before.slice(0, at)) && options.every((w) => !w.quoted && w.value.startsWith("-"));
}

function addRedirect(segment: Segment, t: RedirectToken): void {
  segment.redirects.push(`${t.fd ?? ""}${t.op}${t.target?.value ?? ""}`);
  if (t.body === null) {
    if (t.target) segment.targets.push(t.target);
  } else if (t.target?.quoted !== true) segment.bodies.push(t.body);
}

function segmentMayWrite(segment: Segment): boolean {
  const { words, arith, targets } = segment;
  if (arith) return [...words, ...targets].some(isRunTime);
  if (expandedTexts(segment).some(holdsRunTimeWrite)) return true;
  if (segment.conditional === "test") return testMayWrite(words);
  if (segment.conditional === "both" && testMayWrite(words)) return true;
  const { command, args } = splitCommand(words);
  return command ? commandMayWrite(command, args) : false;
}

/** The command word past any prefix, assignment or option, and its arguments; `function NAME` defines, not runs. */
export function splitCommand(words: WordToken[]): { command?: WordToken; args: WordToken[] } {
  const at = words.findIndex((w) => !COMMAND_PREFIXES.has(w.value) && !ASSIGNMENT_RE.test(w.value) && !isOption(w));
  if (at < 0) return { args: [] };
  if (words[at]?.value === "function") return splitCommand(words.slice(at + 2));
  return { command: words[at], args: words.slice(at + 1) };
}

/**
 * A command word that is not a static literal may become any builtin, `source` and `declare -n` included, so it
 * answers true whatever its arguments look like, as does a builtin this model does not read.
 */
function commandMayWrite(command: WordToken, args: WordToken[]): boolean {
  const name = command.value;
  if (TESTS.has(name)) return testMayWrite(args);
  if (isRunTime(command) || COMMAND_BUILDER_RE.test(name)) return true;
  if (SOURCERS.has(name) || runsCode(name, args) || (SHELL_BUILTINS.has(name) && !MODELED.has(name))) return true;
  const slots = nameSlots(name, args);
  if (typeof slots === "string") return true;
  return slots.some(nameMayBeRunTime) || namerefMayBeRunTime(name, args);
}

/**
 * A test form evaluates its arithmetic operands, and each test command evaluates the subscript of the name `-v`
 * checks, so a run-time operand there may hold `IFS=1`.
 */
function testMayWrite(args: WordToken[]): boolean {
  return testArithOperands(args).some(isRunTime) || args.some((a, i) => isRunTime(a) && args[i - 1]?.value === "-v");
}

/**
 * Operands a test form evaluates as arithmetic, as the union of bash and zsh: both sides of `-eq` to `-ge` (bash
 * in `[[ ]]`, zsh in `[[ ]]`, `[ ]` and `test`), and zsh's `-t` operand, which it reads as a math expression
 * rather than a descriptor number, so `[[ -t x ]]` evaluates x's value.
 */
export function testArithOperands(args: WordToken[]): WordToken[] {
  return args.filter((_, i) => {
    const before = args[i - 1]?.value ?? "";
    return before === "-t" || ARITH_TESTS.has(before) || ARITH_TESTS.has(args[i + 1]?.value ?? "");
  });
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

function holdsRunTimeWrite(text: string): boolean {
  return RUN_TIME_WRITE_RES.some((re) => re.test(text));
}

export function isRunTime(w: WordToken): boolean {
  return w.dynamic || w.computed;
}

function isOption(w: WordToken): boolean {
  return !isRunTime(w) && /^[-+]./s.test(w.value);
}
