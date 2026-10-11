import type { RedirectToken, Token, WordToken } from "./lexer.js";
import { printedText } from "./printed.js";
import { unwrap } from "./unwrap.js";

/**
 * The words with each command substitution's output spliced in where the substitution sits, as `eval` and `-c` read
 * them. Output is known when literal on the line: one `echo` or `printf` with static arguments, or one `cat` reading a
 * heredoc or here-string. Any other substitution prints text only known at run time and splices in nothing.
 */
export function splicedWords(words: WordToken[]): WordToken[] {
  return words.map((word) => (word.cuts ? { ...word, value: spliced(word, word.cuts) } : word));
}

function spliced(word: WordToken, cuts: NonNullable<WordToken["cuts"]>): string {
  let value = "";
  let last = 0;
  for (const { at, sub } of cuts) {
    const tokens = word.subs[sub];
    const output = tokens ? (subOutput(tokens) ?? "") : "";
    value += word.value.slice(last, at) + output.replace(/\n+$/, "");
    last = at;
  }
  return value + word.value.slice(last);
}

/** Output only counts when bash and zsh, either of which may run the line, would print exactly the same text. */
function subOutput(tokens: Token[]): string | null {
  const body = soleCommand(tokens);
  if (!body) return null;
  const cmd = unwrap(body.words);
  if (!cmd) return null;
  if (cmd.name === "cat") return readsOnlyStdin(cmd.args) ? literalStdin(body.redirects) : null;
  // Bash's echo prints `\0043` as written where zsh's decodes it, so a backslash leaves the output unknown.
  return cmd.args.some((a) => a.value.includes("\\")) ? null : printedText(cmd.name, cmd.args);
}

function readsOnlyStdin(args: WordToken[]): boolean {
  return !args.some((a) => a.dynamic) && catOperands(args.map((a) => a.value)).every((v) => v === "-");
}

/** A here-string's word is literal only when it expands nothing; a heredoc body only once the shell has processed it. */
function literalStdin(redirects: RedirectToken[]): string | null {
  const feed = [...redirects].reverse().find((r) => r.body !== null || r.op === "<<<");
  if (!feed || feed.target === null) return null;
  if (feed.op === "<<<") return feed.target.dynamic ? null : feed.target.value;
  return feed.target.quoted ? feed.body : unquotedBody(feed.body ?? "");
}

/**
 * An unquoted-delimiter heredoc body as the shell feeds it: a backslash before `\`, `$`, a backquote or a newline is
 * removed, any other stays. An unescaped `$` or backquote expands at run time, which leaves the text unknown.
 */
function unquotedBody(body: string): string | null {
  const escape = /\\([\\$`\n])/g;
  if (/[$`]/.test(body.replace(escape, ""))) return null;
  return body.replace(escape, (_: string, escaped: string) => (escaped === "\n" ? "" : escaped));
}

/** The words and redirects of the substitution's only command; trailing separators are allowed, anything else is not. */
function soleCommand(tokens: Token[]): { words: WordToken[]; redirects: RedirectToken[] } | null {
  const end = tokens.findIndex((t) => t.type === "op");
  if (end >= 0 && tokens.slice(end).some((t) => t.type !== "op" || !["\n", ";"].includes(t.value))) return null;
  const parts = end < 0 ? tokens : tokens.slice(0, end);
  if (parts.some((t) => t.type === "subs")) return null;
  const words = parts.filter((t): t is WordToken => t.type === "word");
  return words.length === 0 ? null : { words, redirects: parts.filter((t): t is RedirectToken => t.type === "redirect") };
}

/** `cat`'s file operands; `-` reads stdin and counts as one. */
export function catOperands(values: string[]): string[] {
  const end = values.indexOf("--");
  const options = end < 0 ? values : values.slice(0, end);
  const operands = options.filter((v) => v === "-" || !v.startsWith("-"));
  return end < 0 ? operands : [...operands, ...values.slice(end + 1)];
}

/** The text a heredoc or here-string feeds the command, the last one winning. */
export function stdinScript(redirects: RedirectToken[]): string | null {
  const feed = [...redirects].reverse().find((r) => r.body !== null || r.op === "<<<");
  if (!feed) return null;
  return feed.body ?? feed.target?.value ?? null;
}
