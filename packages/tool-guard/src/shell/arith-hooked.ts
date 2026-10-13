import { HOOKED_MENTION_RE } from "./hooked-names.js";
import type { WordToken } from "./lexer.js";
import type { Unwrapped } from "./unwrap.js";

const NUMERIC_TEST_RE = /^-(?:eq|ne|lt|le|gt|ge)$/;
const INTEGER_DECLARERS = new Set(["declare", "typeset", "local", "export", "readonly", "private"]);
const INTEGER_OPTION_RE = /^-[A-Za-z0-9]*i/;
const SUBSCRIPTED_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*\[.*\]\+?=/s;
/** bash `${x:offset}`: a colon after the name that opens no `:-`, `:=`, `:+`, `:?` or zsh `:#` operator. */
const SUBSTRING_AT_RE = /\$\{[!#]?[A-Za-z_][A-Za-z0-9_]*:(?![-=+?#])/y;
const NAME_CHAR_RE = /[A-Za-z0-9_]/;

/**
 * The hooked parameter an arithmetic expression mentions. bash and zsh assign inside one (`MODULE_PATH = 1`,
 * `PS4++`), and a mere read is rare enough there to refuse with it. The walk passes each `(( ))` span here.
 */
export function arithmeticHooked(expression: string): string | null {
  return mentionFrom(expression, 0);
}

/**
 * The hooked parameter a command's arithmetic mentions: `let`'s arguments, the operands of a numeric `[[` test, a
 * `declare -i` or zsh `integer`/`float` value, and the arithmetic inside a word: `$(( ))`, `$[ ]`, a subscript or a
 * bash substring offset in a dynamic word, and a subscript in an assignment word or a name slot.
 */
export function arithmeticHookedIn(cmd: Unwrapped, words: WordToken[], slots: WordToken[]): string | null {
  for (const text of wholeExpressions(cmd)) {
    const hooked = mentionFrom(text, 0);
    if (hooked !== null) return hooked;
  }
  const named = [...words.filter((w) => !w.dynamic && SUBSCRIPTED_ASSIGNMENT_RE.test(w.value)), ...slots];
  for (const word of [...words, ...cmd.args].filter((w) => w.dynamic).concat(named)) {
    const opener = arithmeticOpener(word.value, word.dynamic);
    const hooked = opener < 0 ? null : mentionFrom(word.value, opener);
    if (hooked !== null) return hooked;
  }
  return null;
}

/** Texts the command evaluates whole as arithmetic. */
function wholeExpressions({ name, args }: Unwrapped): string[] {
  const values = args.map((a) => a.value);
  if (name === "let") return values;
  if (name === "[[" && values.some((v) => NUMERIC_TEST_RE.test(v))) return values;
  const integer = name === "integer" || name === "float" || (name !== null && INTEGER_DECLARERS.has(name) && values.some((v) => INTEGER_OPTION_RE.test(v)));
  return integer ? values.flatMap((v) => (v.includes("=") ? [v.slice(v.indexOf("=") + 1)] : [])) : [];
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

function mentionFrom(text: string, from: number): string | null {
  HOOKED_MENTION_RE.lastIndex = from;
  return HOOKED_MENTION_RE.exec(text)?.[0] ?? null;
}
