import type { RedirectToken, Token, WordToken } from "./lexer.js";
import { printedText } from "./printed.js";
import { unwrap } from "./unwrap.js";

/**
 * Text the words' command substitutions print, where it is literal on the line: one `echo` or `printf` with static
 * arguments, or one `cat` reading a heredoc or here-string. `eval "$(cat <<'E' … E)"` runs that text, not the `cat`.
 * Any other substitution prints text only known at run time and yields nothing.
 */
export function knownOutputs(words: WordToken[]): string[] {
  return words.flatMap((word) => word.subs.flatMap((sub) => subOutput(sub) ?? []));
}

function subOutput(tokens: Token[]): string | null {
  const body = soleCommand(tokens);
  if (!body) return null;
  const cmd = unwrap(body.words);
  if (!cmd) return null;
  if (cmd.name === "cat") return readsOnlyStdin(cmd.args) ? literalStdin(body.redirects) : null;
  return printedText(cmd.name, cmd.args);
}

function readsOnlyStdin(args: WordToken[]): boolean {
  return !args.some((a) => a.dynamic) && catOperands(args.map((a) => a.value)).every((v) => v === "-");
}

/** A here-string's word is literal only when it expands nothing; a heredoc body is read as written. */
function literalStdin(redirects: RedirectToken[]): string | null {
  const feed = [...redirects].reverse().find((r) => r.body !== null || r.op === "<<<");
  return feed?.op === "<<<" && feed.target?.dynamic ? null : stdinScript(redirects);
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
