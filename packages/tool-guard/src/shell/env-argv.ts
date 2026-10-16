import { envSplitWords } from "./env-split.js";
import type { EnvWord } from "./env-split.js";
import type { WordToken } from "./lexer.js";
import { tokenize } from "./lexer.js";

/** How env's own options read: where a `-S` option's text sits, and which options take the next word. */
export interface EnvSyntax {
  scriptAt: (word: string) => { attached: string } | "next" | null;
  takesValue: (word: string) => boolean;
}

const ENV_PARAM_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g;

/**
 * The words env puts in place of a `-S` option and its string, split by env's rules, so env's own options at its head
 * (`-u X`, `-a sh`, `-i`) are read as options, not as a command. Null when they cannot be known: a dynamic `-S` word,
 * a missing one, an unclosed quote, a backslash, or a `${NAME}` among env's options or as its command, which the walk
 * never expands since it rebuilds these words after expanding the line's.
 */
export function envArgv(option: WordToken, at: { attached: string } | "next", next: WordToken | undefined, syntax: EnvSyntax): WordToken[] | null {
  const text = at === "next" ? next : option;
  if (text === undefined || option.dynamic || text.dynamic) return null;
  const split = envSplitWords(at === "next" ? text.value : at.attached);
  if (split === null) return null;
  const head = [...clusterBefore(option.value, at), ...split];
  return dynamicHead(head, syntax) ? null : envTokens(head);
}

/** Whether a `${NAME}` sits among env's leading options or in the command word after them, where its value decides what runs. */
function dynamicHead(words: EnvWord[], syntax: EnvSyntax): boolean {
  for (let j = 0, word = words[0]; word !== undefined; word = words[j]) {
    if (word.dynamic) return true;
    if (!word.value.startsWith("-")) return false;
    if (word.value === "--") return words[j + 1]?.dynamic ?? false;
    j += syntax.takesValue(word.value) ? 2 : 1;
  }
  return false;
}

/** The short options a cluster holds before its `S` (`-i` of `-iS`), as a word of their own. */
function clusterBefore(v: string, at: { attached: string } | "next"): EnvWord[] {
  if (v.startsWith("--")) return [];
  const flags = at === "next" ? v.slice(0, -1) : v.slice(0, v.length - at.attached.length - 1);
  return flags.length > 1 ? [{ value: flags, dynamic: false }] : [];
}

/** env's words as the shell words that read the same, so a `${NAME}` env expands carries its reference as `"${NAME}"` does. */
function envTokens(words: EnvWord[]): WordToken[] {
  return tokenize(words.map(envShellWord).join(" ")).filter((t): t is WordToken => t.type === "word");
}

/** Literal text single-quoted, since env expands no `~`, glob or `$NAME`, and each `${NAME}` left live. */
function envShellWord(word: EnvWord): string {
  if (!word.dynamic) return singleQuoted(word.value);
  let out = "";
  let last = 0;
  for (const m of word.value.matchAll(ENV_PARAM_RE)) {
    out += `${singleQuoted(word.value.slice(last, m.index))}"${m[0]}"`;
    last = m.index + m[0].length;
  }
  return out + singleQuoted(word.value.slice(last));
}

function singleQuoted(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}
