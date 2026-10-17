export interface EnvWord {
  value: string;
  /** A `${NAME}` outside single quotes: env expands it, so the word is only known at run time. */
  dynamic: boolean;
}

const BLANK_RE = /[ \t\n\v\f\r]/;

/**
 * The words `env -S` makes of its string, by env's rules and not a shell's: blanks split, quotes group, a `#` that
 * starts a word ends the string, and `${NAME}` outside single quotes expands. Null for an unclosed quote, any
 * backslash (env's escapes) or a `$` outside single quotes with no `{` after it (`$G`, `$$`, `$1`, `$?`, `$(`, a
 * trailing `$`), which GNU and uutils env both reject; all fail closed.
 */
export function envSplitWords(text: string): EnvWord[] | null {
  if (text.includes("\\")) return null;
  const words: EnvWord[] = [];
  let word: EnvWord | undefined;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (quote === "" && BLANK_RE.test(c)) {
      if (word) words.push(word);
      word = undefined;
    } else if (quote === "" && c === "#" && !word) break;
    else if (c === quote) quote = "";
    else if (quote === "" && (c === "'" || c === '"')) {
      quote = c;
      word ??= { value: "", dynamic: false };
    } else {
      if (c === "$" && quote !== "'" && text.charAt(i + 1) !== "{") return null;
      word ??= { value: "", dynamic: false };
      word.value += c;
      if (c === "$" && quote !== "'" && text.charAt(i + 1) === "{") word.dynamic = true;
    }
  }
  if (quote !== "") return null;
  if (word) words.push(word);
  return words;
}
