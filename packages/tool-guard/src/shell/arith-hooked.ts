import { bindsComputedName } from "./computed-binding.js";
import type { HandedText } from "./computed-binding.js";
import { assignedInMath, mentionedIn } from "./hooked-names.js";
import { mathPlaces } from "./math-places.js";
import type { RedirectToken, WordToken } from "./lexer.js";
import type { Unwrapped } from "./unwrap.js";

const NUMERIC_TEST_RE = /^-(?:eq|ne|lt|le|gt|ge)$/;
/** zsh builtins whose arguments are math: `repeat 'PS4=1' true` and `return 'PS4=1'` assign PS4. */
const MATH_ARG_BUILTINS = new Set(["repeat", "shift", "return", "exit", "break", "continue"]);
const PRINT_FORMAT_RE = /^-[A-Za-z]*f/;
const TEST_COMMANDS = new Set(["[", "test"]);
const INTEGER_DECLARERS = new Set(["declare", "typeset", "local", "export", "readonly", "private"]);
const INTEGER_OPTION_RE = /^-[A-Za-z0-9]*i/;
const SUBSCRIPTED_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*\[.*\]\+?=/s;
/** bash `${x:offset}`: a colon after the name that opens no `:-`, `:=`, `:+`, `:?` or zsh `:#` operator. */
const SUBSTRING_AT_RE = /\$\{[!#]?(?:[A-Za-z_][A-Za-z0-9_]*|[@*]|\d+):(?![-=+?#])/y;
const NAME_CHAR_RE = /[A-Za-z0-9_]/;

/** Whether the builtin reads every argument as math: `let 'x=1'`, `shift "$n"`, `return 'PS4=1'`. */
export function evaluatesArgsAsMath(name: string): boolean {
  return name === "let" || MATH_ARG_BUILTINS.has(name);
}

/**
 * The hooked parameter an arithmetic expression mentions. bash and zsh assign inside one (`MODULE_PATH = 1`,
 * `PS4++`), and a mere read is rare enough there to refuse with it. The walk passes each `(( ))` span here.
 */
export function arithmeticHooked(expression: string): string | null {
  return mentionedIn(expression);
}

/**
 * The hooked parameter a command's arithmetic mentions: `let`'s arguments, the operands of a numeric `[[` test, a
 * `declare -i` or zsh `integer`/`float` value, and the arithmetic inside a word: `$(( ))`, `$[ ]`, a subscript or a
 * bash substring offset in a dynamic word, and a subscript in an assignment word or a name slot.
 */
export function arithmeticHookedIn(cmd: Unwrapped, words: WordToken[], slots: WordToken[], redirects: RedirectToken[]): string | null {
  for (const text of wholeExpressions(cmd)) {
    const hooked = mentionedIn(text);
    if (hooked !== null) return hooked;
  }
  const handed = handedTexts(cmd, words, redirects);
  for (const text of [...laterExpressions(cmd), ...handed.map((h) => h.text)]) {
    const hooked = assignedInMath(text);
    if (hooked !== null) return hooked;
  }
  const placed = mathPlaces(words, redirects).find((place) => mentionedIn(place.text) !== null);
  if (placed !== undefined) return mentionedIn(placed.text);
  const computed = handed.find(bindsComputedName);
  if (computed !== undefined) return computed.text;
  const named = [...words.filter((w) => !w.dynamic && SUBSCRIPTED_ASSIGNMENT_RE.test(w.value)), ...slots];
  for (const word of [...words, ...cmd.args].filter((w) => w.dynamic).concat(named)) {
    const opener = arithmeticOpener(word.value, word.dynamic);
    const hooked = opener < 0 ? null : mentionedIn(word.value, opener);
    if (hooked !== null) return hooked;
  }
  return null;
}

/** Texts the command evaluates whole as arithmetic. */
function wholeExpressions({ name, args }: Unwrapped): string[] {
  const values = args.map((a) => a.value);
  if (name !== null && evaluatesArgsAsMath(name)) return values;
  if (name === "[[" && values.some((v) => NUMERIC_TEST_RE.test(v))) return values;
  const integer = name === "integer" || name === "float" || (name !== null && INTEGER_DECLARERS.has(name) && values.some((v) => INTEGER_OPTION_RE.test(v)));
  return integer ? values.flatMap((v) => (v.includes("=") ? [v.slice(v.indexOf("=") + 1)] : [])) : [];
}

/**
 * Texts a shell may evaluate as math later or only by format, where a mere mention is not a write: every value the
 * command assigns, read as math by `(( x ))` or `${a[x]}` once `x='PS4=1'`, and zsh printf operands, which `%d`
 * evaluates.
 */
function laterExpressions({ name, args, assigned }: Unwrapped): string[] {
  const values = assigned.flatMap(([, value]) => value ?? []);
  const declared = name !== null && (INTEGER_DECLARERS.has(name) || name === "integer" || name === "float");
  if (declared) values.push(...args.flatMap((a) => (a.value.includes("=") ? [a.value.slice(a.value.indexOf("=") + 1)] : [])));
  const formatted = name === "printf" || (name === "print" && args.some((a) => PRINT_FORMAT_RE.test(a.value)));
  return formatted ? [...values, ...args.map((a) => a.value)] : values;
}

/**
 * The raw text of every word the command hands on, dynamic ones included, which a shell may store and later read
 * as math: `unset 'a[PS4=7]'`, `f "PS4=$v"`, `select x in 'PS4=7'`, an array element `[PS4=7]=x`, a herestring or
 * heredoc body. `[` and `test` evaluate none of theirs, apart from the name a `-v` test reads, whose subscript is
 * math.
 */
function handedTexts({ name, args }: Unwrapped, words: WordToken[], redirects: RedirectToken[]): HandedText[] {
  const handed = (w: WordToken): HandedText => ({
    text: w.value, dynamic: w.dynamic, braces: !w.quoted || w.spliced, globs: !w.quoted, rewrites: true, cuts: (w.cuts ?? []).map((cut) => cut.at),
  });
  const inputs = redirects.flatMap((r) => [...(r.target ? [handed(r.target)] : []), ...(r.body === null ? [] : [heredocBody(r.body, r.target)])]);
  if (name !== null && TEST_COMMANDS.has(name)) return [...args.filter((_, i) => args[i - 1]?.value === "-v").map(handed), ...inputs];
  return [...[...words, ...args].map(handed), ...inputs];
}

/** A heredoc body expands unless its delimiter is quoted (`<<'EOF'`); no printf rewrites it. */
function heredocBody(text: string, delimiter: WordToken | null): HandedText {
  return { text, dynamic: delimiter?.quoted !== true, braces: false, globs: false, rewrites: false, cuts: [] };
}

/** Where the first arithmetic in the text starts, or -1. A literal word opens only at a subscript. */
function arithmeticOpener(text: string, dynamic: boolean): number {
  for (let i = 0; i < text.length; i++) {
    if (dynamic && (text.startsWith("$((", i) || text.startsWith("$[", i))) return i;
    if (text[i] === "[" && NAME_CHAR_RE.test(text.charAt(i - 1))) return i + 1;
    if (dynamic && text.startsWith("${", i)) {
      SUBSTRING_AT_RE.lastIndex = i;
      const substring = SUBSTRING_AT_RE.exec(text);
      if (substring) return i + substring[0].length;
    }
  }
  return -1;
}
