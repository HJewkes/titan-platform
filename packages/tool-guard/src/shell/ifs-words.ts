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
