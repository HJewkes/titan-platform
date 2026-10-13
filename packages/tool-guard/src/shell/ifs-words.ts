import type { RedirectToken, SubsToken, Token, WordToken } from "./tokens.js";

/**
 * A word that may name IFS once brace expansion or quote removal has run: `{I,}FS`, `I{F,}S`, `${IFS:=,}`.
 * Dynamic words keep their raw text, so this also catches `$IFS` and `$((IFS=1))`.
 */
const POSSIBLY_IFS_RE = /I.*F.*S/s;
/** The same test for PS4, the prompt xtrace expands: `PS4[0]`, `{P,}S4`, `P{S,}4`, `-vPS4`. */
const POSSIBLY_PS4_RE = /P.*S.*4/s;
const ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?(\+?)=(.*)$/s;
const OPTION_RE = /^[-+][A-Za-z]+$/;
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

/**
 * An assignment value the shell rewrites after the lexer: `~`, `~+` or `~-` at the start or after a `:`
 * (`IFS=a:~`), zsh's `=cmd` at the start or after a `:` (`IFS=a:=ls`), and a glob under zsh's `globassign`
 * (`IFS=/e*`). Tokens keep no record of which characters were quoted.
 */
const ASSIGNED_REWRITE_RE = /(?:^|:)[~=]|[*?[]/;
/**
 * The only declarer options known to leave IFS's value as written: readonly, export and global, set or
 * cleared, and `--`. Any other option may transform it (`-u`, `-i`, `-a`, zsh `-Z3`, `-L3`, `-R3`, `-E`).
 */
const SAFE_DECLARER_OPTION_RE = /^(?:[-+][rxg]+|--)$/;
const OPTION_WORD_RE = /^[-+]./s;
/** zsh's `integer` and `float` are `typeset -i` and `typeset -E` under another name. */
const TRANSFORMING_DECLARERS = new Set(["integer", "float"]);
/** A command word is also globbed and brace-expanded: `*`, `?`, `[`, `{a,b}`, `{1..3}`, and zsh's `^` and `#`. */
const WORD_REWRITE_RE = /^[~=]|[*?[^#]|\{[^}]*(?:,|\.\.)[^}]*\}/;

export interface Assignment {
  name: string;
  plain: boolean;
  subscript: string;
  value: string;
}

export function possiblyIfs(text: string): boolean {
  return POSSIBLY_IFS_RE.test(text);
}

export function possiblyPs4(text: string): boolean {
  return POSSIBLY_PS4_RE.test(text);
}

/** The shell may turn this IFS value into other text at run time, so its literal reading is not the value. */
export function rewritesAssignedValue(text: string): boolean {
  return ASSIGNED_REWRITE_RE.test(text);
}

/** As `rewritesAssignedValue`, for a `for IFS in` word or a declarer operand, which glob and brace-expand too. */
export function rewritesWord(text: string): boolean {
  return ASSIGNED_REWRITE_RE.test(text) || WORD_REWRITE_RE.test(text);
}

/**
 * `declare -u IFS`, `local -i IFS=0x2f` or zsh `typeset -Z3 IFS=1`: IFS may hold a transformed value, not the
 * text assigned. Only an allowlist of options counts as safe, so an unknown or attached-width option fails closed.
 */
export function transformsIfs(command: string, args: WordToken[]): boolean {
  const options = args.filter((word) => OPTION_WORD_RE.test(word.value));
  const unsafe = TRANSFORMING_DECLARERS.has(command) || options.some((word) => word.dynamic || !SAFE_DECLARER_OPTION_RE.test(word.value));
  return unsafe && args.some((word) => !OPTION_WORD_RE.test(word.value) && possiblyIfs(parseAssignment(word.value)?.name ?? word.value));
}

/** `IFS=(a b)`: an array IFS splits on its first element, which this scan does not read. */
export function opensIfsArray(tokens: Token[], i: number): boolean {
  const before = tokens[i - 1];
  if (!isOp(tokens[i], "(") || before?.type !== "word") return false;
  const assignment = parseAssignment(before.value);
  return assignment !== null && assignment.value === "" && possiblyIfs(assignment.name);
}

export function isOption(text: string): boolean {
  return OPTION_RE.test(text);
}

export function isAssignment(text: string): boolean {
  return ASSIGNMENT_RE.test(text);
}

export function readsTextByName(text: string): boolean {
  return READS_BY_NAME_RE.test(text);
}

export function namesSubscript(text: string): boolean {
  return SUBSCRIPTED_NAME_RE.test(text);
}

export function elementSubscript(text: string): string | undefined {
  return ELEMENT_SUBSCRIPT_RE.exec(text)?.[1];
}

export function namesStartupFile(text: string): boolean {
  return STARTUP_FILE_RE.test(text);
}

export function isSourcingOption(text: string): boolean {
  return SOURCING_OPTION_RE.test(text);
}

/** `bash <(printf %s "$v")` and `bash -s <<< "$v"` hand a command text this scan cannot read. */
export function feedsDynamicText(token: SubsToken | RedirectToken): boolean {
  if (token.type === "subs" || token.subs.length > 0) return true;
  return token.target?.dynamic === true || /[$`]/.test(token.body ?? "");
}

/** `((` opens an arithmetic command, or `for ((`, which runs until its first `)`; a nested subshell `( (` only reads stricter. */
export function opensArithmetic(tokens: Token[], i: number): boolean {
  const before = tokens[i - 1];
  return isOp(tokens[i], "(") && before !== undefined && isOp(before, "(");
}

function isOp(token: Token | undefined, value: string): boolean {
  return token?.type === "op" && token.value === value;
}

/** `$(( $n = 1 ))`: a dynamic name, or text that may name IFS, inside arithmetic may assign IFS. */
export function arithmeticUnknown(word: WordToken): boolean {
  return word.dynamic && arithmeticTextUnknown(word.value);
}

export function arithmeticTextUnknown(text: string): boolean {
  for (const match of text.matchAll(ARITHMETIC_EXPANSION_RE)) {
    const rest = text.slice(match.index + match[0].length);
    if (rest.includes("$") || possiblyIfs(rest)) return true;
  }
  return false;
}

export function isPrefixAssignment(word: WordToken | undefined): boolean {
  return word !== undefined && !whollyQuoted(word) && ASSIGNMENT_RE.test(word.value);
}

/** `export {P,}S4=…` declares PS4 after brace expansion, which no assignment check reads as PS4. */
export function declaresPs4Spelling(word: WordToken): boolean {
  const name = parseAssignment(word.value)?.name ?? word.value;
  return name !== "PS4" && possiblyPs4(name);
}

/** `export IFS=~` or `declare IFS=*`: a declarer operand may be expanded like a word, not only like a value. */
export function declaresRewrittenIfs(word: WordToken): boolean {
  const assignment = parseAssignment(word.value);
  return assignment?.name === "IFS" && rewritesWord(assignment.value);
}

/** `export PATH="$HOME/bin"` names its variable literally; `declare "${x}S=,"` does not. */
export function dynamicDeclarationKnown(word: WordToken): boolean {
  const assignment = parseAssignment(word.value);
  return assignment !== null && assignment.name !== "IFS" && !possiblyIfs(assignment.value) && !subscriptUnknown(assignment);
}

/** `printf -v NAME` and `printf -vNAME` write NAME. */
export function printfTargetDynamic(args: WordToken[]): boolean {
  return args.some((word, i) => (literal(word) === "-v" && args[i + 1]?.dynamic === true) || (word.dynamic && word.value.startsWith("-v")));
}

export function parseAssignment(text: string): Assignment | null {
  const match = ASSIGNMENT_RE.exec(text);
  if (!match) return null;
  return { name: match[1]!, plain: match[2] === undefined && match[3] === "", subscript: match[2] ?? "", value: match[4]! };
}

/** `a[IFS=1]=x` and `a[$n]=x`: an indexed array's subscript is arithmetic, which may assign. */
export function subscriptUnknown(assignment: Assignment): boolean {
  return assignment.subscript.includes("$") || possiblyIfs(assignment.subscript);
}

/** `'IFS=,; true'` in command position runs a command of that name; it assigns nothing. */
function whollyQuoted(word: WordToken): boolean {
  return word.quoted && !word.spliced;
}

export function literal(word: WordToken | undefined): string {
  return word && !word.dynamic && !word.quoted ? word.value : "";
}
