import { ParseError, tokenize } from "./lexer.js";
import { NestingLimitError } from "./nesting.js";
import type { RedirectToken, SubsToken, Token, WordToken } from "./tokens.js";

/** What bash starts with and what `unset IFS` restores. */
export const DEFAULT_IFS = " \t\n";

/** How many `eval` or `sh -c` texts deep a value is still looked for; deeper text leaves IFS unknown. */
const MAX_RESCAN = 2;
/**
 * A word that may name IFS once brace expansion or quote removal has run: `{I,}FS`, `I{F,}S`, `${IFS:=,}`.
 * Dynamic words keep their raw text, so this also catches `$IFS` and `$((IFS=1))`.
 */
const POSSIBLY_IFS_RE = /I.*F.*S/s;
const ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?(\+?)=(.*)$/s;
const OPTION_RE = /^[-+][A-Za-z]+$/;
const RESERVED = new Set(["!", "{", "}", "if", "then", "elif", "else", "fi", "while", "until", "do", "done", "time"]);
const PREFIXES = new Set(["command", "builtin"]);
const DECLARERS = new Set(["local", "export", "declare", "typeset", "readonly"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh"]);
/** Builtins that write a variable named by an operand; a dynamic operand may name IFS. */
const NAME_WRITERS = new Set(["read", "mapfile", "readarray", "getopts", "wait", "let", "select"]);
/** Builtins that run shell text from a file or stdin, which no word on the line spells out. */
const SOURCERS = new Set(["source", "."]);
/** Commands that run another command or stored shell text; a dynamic operand may be any code at all. */
const RUNNERS = new Set(["trap", "alias", "exec", "coproc", "nohup", "env", "sudo", "doas", "timeout", "nice", "xargs", "stdbuf", "setsid", "watch", "parallel", "su"]);
/** `$(( ))` and `$[ ]`: arithmetic assigns, and a name's value is itself read as an expression. */
const ARITHMETIC_EXPANSION_RE = /\$(?:\(\(|\[)/g;
/**
 * Expansions that evaluate a variable's text, not just its value: `$(( v ))`, `$[ v ]`, `${v@P}`, a subscript
 * `${a[v]}`, and a substring offset `${x:v}` (the `:-`, `:=`, `:?` and `:+` defaults excluded).
 */
const READS_BY_NAME_RE = /\$\(\(|\$\[|@P\}|\$\{!|\$\{[^}]*\[|\$\{[#!]?[A-Za-z0-9_@*]+:(?![-=?+])/;
/** A name operand with a non-numeric subscript, `read 'a[k]'` or `[[ -v a[k] ]]`: the subscript is arithmetic. */
const SUBSCRIPTED_NAME_RE = /[A-Za-z_][A-Za-z0-9_]*\[(?!\d*\])/;
/** A compound-array element `[k]=v` inside `a=( )`, `a+=( )` or `declare -a a=( )`; its subscript is arithmetic. */
const ELEMENT_SUBSCRIPT_RE = /^\[([^\]]*)\]\+?=/;
/** Variables naming a file every non-interactive `bash` or `sh` sources before its script. */
const STARTUP_FILE_RE = /^(?:BASH_ENV|ENV)\+?=/;
/** Shell options that source an rc or profile file: `--rcfile`, `--init-file`, `--login`, `-i`, `-l`, `-lc`. */
const SOURCING_OPTION_RE = /^(?:--(?:rcfile|init-file|login|interactive)\b|-[A-Za-z]*[il])/;
const ARITHMETIC_TESTS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);
/** Commands whose operands are stored as code, run later by name. */
const STORED_CODE = new Set(["trap", "alias"]);

interface Scan {
  found: Set<string>;
  unknown: boolean;
  /** The line stores a value only known at run time: `v=$(cmd)`, `v=$x`, `read v`, `for v in $L`. */
  computed: boolean;
  /** The line evaluates some variable's text by name: `(( v ))`, `let v`, `${v@P}`, `a[v]=x`, `trap`, `declare -i`. */
  readsByName: boolean;
  /** Names declared `-n`, and names given a run-time value or used as a `for` variable, matched at the end. */
  namerefs: Set<string>;
  runtimeNames: Set<string>;
}

interface Assignment {
  name: string;
  plain: boolean;
  subscript: string;
  value: string;
}

/**
 * Every IFS a line could hold when one of its expansions splits: the default first, then each distinct
 * non-empty literal value the line assigns anywhere, in order. An empty IFS never splits, so it adds no reading.
 * Null when a word that may name IFS after expansion does not resolve to a literal value (`IFS+=,`, `read IFS`,
 * `${IFS:=,}`, `{I,}FS=,`, `IFS=$V`), a name-writing command takes a dynamic name, shell text it runs is dynamic
 * (`eval "$v"`, `sh -c "$v"`, `source`, `trap "$v"`, `bash <<< "$v"`), or arithmetic holds a dynamic name, so a
 * caller fails closed. Any value the line stores that may name IFS also gives null: `v=IFS=,` can reach `(( v ))`,
 * `${v@P}`, `trap` or another reader of stored text later, and following every such reader is not attempted.
 * For the same reason a line that both stores a run-time value and evaluates any variable's text by name gives
 * null, in either order, since a loop or a function call can run the reader after the store.
 */
export function lineIfsValues(tokens: Token[]): string[] | null {
  const scan: Scan = { found: new Set([DEFAULT_IFS]), unknown: false, computed: false, readsByName: false, namerefs: new Set(), runtimeNames: new Set() };
  scanTokens(tokens, 0, scan);
  return scan.unknown || (scan.computed && scan.readsByName) || namerefRetargeted(scan) ? null : [...scan.found];
}

/** `declare -n r; for r in $L` or `r=$x`: a nameref given a run-time target may write IFS through it. */
function namerefRetargeted(scan: Scan): boolean {
  return [...scan.namerefs].some((name) => scan.runtimeNames.has(name));
}

function scanTokens(tokens: Token[], depth: number, scan: Scan): void {
  let words: WordToken[] = [];
  let input = false;
  let arithmetic = false;
  tokens.forEach((token, i) => {
    if (token.type === "op") {
      scanCommand(words, input, depth, scan);
      words = [];
      input = false;
      arithmetic = opensArithmetic(tokens, i) || (arithmetic && token.value !== ")");
    } else if (token.type === "word") {
      if (arithmetic) scanArithmeticWord(token, depth, scan);
      else words.push(token);
    } else {
      scanSubs(token.subs, depth, scan);
      input ||= feedsDynamicText(token);
      if (token.type === "redirect") scanRedirect(token, arithmetic, depth, scan);
    }
  });
  scanCommand(words, input, depth, scan);
}

/** `bash <(printf %s "$v")` and `bash -s <<< "$v"` hand a command text this scan cannot read. */
function feedsDynamicText(token: SubsToken | RedirectToken): boolean {
  if (token.type === "subs" || token.subs.length > 0) return true;
  return token.target?.dynamic === true || /[$`]/.test(token.body ?? "");
}

/** `((` opens an arithmetic command, or `for ((`, which runs until its first `)`; a nested subshell `( (` only reads stricter. */
function opensArithmetic(tokens: Token[], i: number): boolean {
  const before = tokens[i - 1];
  return isOp(tokens[i], "(") && before !== undefined && isOp(before, "(");
}

function isOp(token: Token | undefined, value: string): boolean {
  return token?.type === "op" && token.value === value;
}

function scanArithmeticWord(word: WordToken, depth: number, scan: Scan): void {
  scanSubs(word.subs, depth, scan);
  scan.readsByName = true;
  if (word.dynamic || possiblyIfs(word.value)) markUnknown(scan);
}

function scanSubs(subs: Token[][], depth: number, scan: Scan): void {
  for (const sub of subs) scanTokens(sub, depth, scan);
}

/**
 * `> ${IFS:=x}` assigns while it expands, and `read v <<< IFS=1` or `bash <<EOF` hands IFS-like text to a reader;
 * inside `(( ))` a `<` reads as a comparison.
 */
function scanRedirect(token: RedirectToken, arithmetic: boolean, depth: number, scan: Scan): void {
  scanHeredocBody(token, scan);
  const target = token.target;
  if (!target) return;
  scanSubs(target.subs, depth, scan);
  noteReadsByName(target, scan);
  if (possiblyIfs(target.value) || (target.dynamic && arithmetic) || arithmeticUnknown(target)) markUnknown(scan);
}

/** `$(( $n = 1 ))`: a dynamic name, or text that may name IFS, inside arithmetic may assign IFS. */
function arithmeticUnknown(word: WordToken): boolean {
  return word.dynamic && arithmeticTextUnknown(word.value);
}

function arithmeticTextUnknown(text: string): boolean {
  for (const match of text.matchAll(ARITHMETIC_EXPANSION_RE)) {
    const rest = text.slice(match.index + match[0].length);
    if (rest.includes("$") || possiblyIfs(rest)) return true;
  }
  return false;
}

/** An unquoted heredoc body expands in the current shell like a double-quoted word; `<<'EOF'` keeps it literal. */
function scanHeredocBody(token: RedirectToken, scan: Scan): void {
  const body = token.body;
  if (body === null) return;
  if (possiblyIfs(body)) return markUnknown(scan);
  if (token.target?.quoted) return;
  if (arithmeticTextUnknown(body)) markUnknown(scan);
  if (READS_BY_NAME_RE.test(body)) scan.readsByName = true;
}

function scanCommand(words: WordToken[], input: boolean, depth: number, scan: Scan): void {
  for (const word of words) {
    scanSubs(word.subs, depth, scan);
    if (arithmeticUnknown(word) || STARTUP_FILE_RE.test(word.value)) markUnknown(scan);
    noteReadsByName(word, scan);
    scanElementSubscript(word, scan);
  }
  let i = 0;
  while (i < words.length && isReserved(words[i])) i++;
  for (; i < words.length && isPrefixAssignment(words[i]); i++) scanAssignment(words[i]!, scan);
  while (i < words.length && PREFIXES.has(literal(words[i]))) i++;
  const [command, ...args] = words.slice(i);
  if (command?.dynamic) return scanDynamicCommand(command, args, input, scan);
  if (command) scanArgs(command, args, input, depth, scan);
}

function noteReadsByName(word: WordToken, scan: Scan): void {
  if ((word.dynamic && READS_BY_NAME_RE.test(word.value)) || SUBSCRIPTED_NAME_RE.test(word.value)) scan.readsByName = true;
}

function scanElementSubscript(word: WordToken, scan: Scan): void {
  const subscript = ELEMENT_SUBSCRIPT_RE.exec(word.value)?.[1];
  if (subscript === undefined) return;
  if (subscript.includes("$") || possiblyIfs(subscript)) markUnknown(scan);
  else if (!/^\d*$/.test(subscript)) scan.readsByName = true;
}

function isReserved(word: WordToken | undefined): boolean {
  return RESERVED.has(literal(word));
}

function isPrefixAssignment(word: WordToken | undefined): boolean {
  return word !== undefined && !whollyQuoted(word) && ASSIGNMENT_RE.test(word.value);
}

/** A dynamic command word may be a declarer, `eval` or `bash`, so any IFS-like or dynamic operand or input is unknown. */
function scanDynamicCommand(command: WordToken, args: WordToken[], input: boolean, scan: Scan): void {
  scan.readsByName = true;
  if (input || possiblyIfs(command.value) || args.some((word) => word.dynamic || possiblyIfs(word.value))) markUnknown(scan);
}

function scanArgs(command: WordToken, args: WordToken[], input: boolean, depth: number, scan: Scan): void {
  const name = command.value;
  if (name === "eval") return scanEval(args, depth, scan);
  if (SOURCERS.has(name)) return markUnknown(scan);
  if (SHELLS.has(name.slice(name.lastIndexOf("/") + 1))) return input ? markUnknown(scan) : scanShell(args, depth, scan);
  if (RUNNERS.has(name) && (input || args.some((word) => word.dynamic))) return markUnknown(scan);
  noteCommandEffects(name, args, scan);
  if (DECLARERS.has(name)) return scanDeclarer(args, scan);
  if (name === "unset") return;
  if (name === "for") return scanFor(args, scan);
  if (NAME_WRITERS.has(name) && args.some((word) => word.dynamic)) return markUnknown(scan);
  if (name === "printf" && printfTargetDynamic(args)) return markUnknown(scan);
  if ([command, ...args].some((word) => possiblyIfs(word.value))) markUnknown(scan);
}

/** Which commands store run-time values, and which evaluate a variable's text by name. */
function noteCommandEffects(name: string, args: WordToken[], scan: Scan): void {
  if ((NAME_WRITERS.has(name) && name !== "let") || (name === "printf" && args.some((word) => word.value.startsWith("-v")))) scan.computed = true;
  if (name === "for" && args.some((word) => word.dynamic)) scan.computed = true;
  if (name === "let" || STORED_CODE.has(name)) scan.readsByName = true;
  if (name === "[[" && args.some((word) => ARITHMETIC_TESTS.has(literal(word)))) scan.readsByName = true;
  if (DECLARERS.has(name) && args.some((word) => !word.dynamic && /^[-+][A-Za-z]*i/.test(word.value))) scan.readsByName = true;
  noteRuntimeNames(name, args, scan);
}

/** Names a command writes from run-time input, which retarget a nameref of that name. */
function noteRuntimeNames(name: string, args: WordToken[], scan: Scan): void {
  const operands = args.filter((word) => !word.dynamic && !OPTION_RE.test(word.value));
  if (NAME_WRITERS.has(name) && name !== "let") for (const word of operands) scan.runtimeNames.add(word.value);
  if (name === "for" && operands[0]) scan.runtimeNames.add(operands[0].value);
  if (name !== "printf") return;
  args.forEach((word, i) => {
    const target = args[i + 1];
    if (literal(word) === "-v" && target && !target.dynamic) scan.runtimeNames.add(target.value);
  });
}

/** `eval` joins its operands with spaces and runs the result as shell text, which is unknown once any is dynamic. */
function scanEval(args: WordToken[], depth: number, scan: Scan): void {
  if (args.some((word) => word.dynamic)) return markUnknown(scan);
  const text = args.map((word) => word.value).join(" ");
  if (text !== "") rescan(text, depth, scan);
}

/** Any operand of `sh` may be the `-c` script, so a dynamic one is unknown; rescanning an option or a path finds nothing. */
function scanShell(args: WordToken[], depth: number, scan: Scan): void {
  if (args.some((word) => word.dynamic || SOURCING_OPTION_RE.test(word.value))) return markUnknown(scan);
  for (const word of args) if (!OPTION_RE.test(word.value)) rescan(word.value, depth, scan);
}

function scanDeclarer(args: WordToken[], scan: Scan): void {
  const nameref = args.some((word) => !word.dynamic && /^-[A-Za-z]*n/.test(word.value));
  for (const word of args) {
    if (!word.dynamic && OPTION_RE.test(word.value)) continue;
    if (nameref && (word.dynamic || possiblyIfs(word.value))) return markUnknown(scan);
    if (nameref) scan.namerefs.add(parseAssignment(word.value)?.name ?? word.value);
    if (word.dynamic && !dynamicDeclarationKnown(word)) return markUnknown(scan);
    if (word.dynamic) noteRuntimeAssignment(word, scan);
    if (!word.dynamic && word.value !== "IFS" && ASSIGNMENT_RE.test(word.value)) scanAssignment(word, scan);
    else if (!word.dynamic && word.value !== "IFS" && possiblyIfs(word.value)) return markUnknown(scan);
  }
}

/** `export PATH="$HOME/bin"` names its variable literally; `declare "${x}S=,"` does not. */
function dynamicDeclarationKnown(word: WordToken): boolean {
  const assignment = parseAssignment(word.value);
  return assignment !== null && assignment.name !== "IFS" && !possiblyIfs(assignment.value) && !subscriptUnknown(assignment);
}

/** `for IFS in a b; do`: each literal list word is a value IFS holds for one pass of the loop. */
function scanFor(args: WordToken[], scan: Scan): void {
  const [variable, keyword, ...list] = args;
  if (list.some((word) => possiblyIfs(word.value))) return markUnknown(scan);
  if (!variable || !possiblyIfs(variable.value)) return;
  if (literal(variable) !== "IFS" || literal(keyword) !== "in" || list.some((word) => word.dynamic)) return markUnknown(scan);
  for (const word of list) add(word.value, scan);
}

/** `printf -v NAME` and `printf -vNAME` write NAME. */
function printfTargetDynamic(args: WordToken[]): boolean {
  return args.some((word, i) => (literal(word) === "-v" && args[i + 1]?.dynamic === true) || (word.dynamic && word.value.startsWith("-v")));
}

function scanAssignment(word: WordToken, scan: Scan): void {
  const assignment = parseAssignment(word.value);
  if (!assignment) return;
  if (subscriptUnknown(assignment) || possiblyIfs(assignment.value)) return markUnknown(scan);
  if (!/^(\[\d*\])?$/.test(assignment.subscript)) scan.readsByName = true;
  if (assignment.name !== "IFS") {
    if (word.dynamic) noteRuntimeAssignment(word, scan);
    return;
  }
  if (!assignment.plain || word.dynamic) return markUnknown(scan);
  add(assignment.value, scan);
}

function noteRuntimeAssignment(word: WordToken, scan: Scan): void {
  scan.computed = true;
  const assignment = parseAssignment(word.value);
  if (assignment) scan.runtimeNames.add(assignment.name);
}

function parseAssignment(text: string): Assignment | null {
  const match = ASSIGNMENT_RE.exec(text);
  if (!match) return null;
  return { name: match[1]!, plain: match[2] === undefined && match[3] === "", subscript: match[2] ?? "", value: match[4]! };
}

/** `a[IFS=1]=x` and `a[$n]=x`: an indexed array's subscript is arithmetic, which may assign. */
function subscriptUnknown(assignment: Assignment): boolean {
  return assignment.subscript.includes("$") || possiblyIfs(assignment.subscript);
}

/** `'IFS=,; true'` in command position runs a command of that name; it assigns nothing. */
function whollyQuoted(word: WordToken): boolean {
  return word.quoted && !word.spliced;
}

function literal(word: WordToken | undefined): string {
  return word && !word.dynamic && !word.quoted ? word.value : "";
}

function possiblyIfs(text: string): boolean {
  return POSSIBLY_IFS_RE.test(text);
}

function markUnknown(scan: Scan): void {
  scan.unknown = true;
}

function add(value: string, scan: Scan): void {
  if (value !== "") scan.found.add(value);
}

/** Shell text run by `eval` or `sh -c`, read the way that shell reads it. */
function rescan(text: string, depth: number, scan: Scan): void {
  if (depth >= MAX_RESCAN) return markUnknown(scan);
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch (error) {
    if (!(error instanceof ParseError || error instanceof NestingLimitError)) throw error;
    return markUnknown(scan);
  }
  scanTokens(tokens, depth + 1, scan);
}
