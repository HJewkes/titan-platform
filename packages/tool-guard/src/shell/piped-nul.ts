import { tokenize } from "./lexer.js";
import type { RedirectToken, Token, WordToken } from "./lexer.js";

/**
 * exec ends a word at its first NUL, so whatever expands after it is gone. A substitution's position in
 * the word is not recorded, so one with no variable reference before the NUL reads as static here; the
 * NUL-dropped reading, walked alongside, keeps the word dynamic.
 */
function cutWord(word: WordToken): WordToken {
  const at = word.value.indexOf("\0");
  const subs = word.subs.map(cutTokens);
  if (at === -1) return { ...word, subs };
  const refs = word.refs.filter((ref) => ref.start < at);
  const cut: WordToken = { ...word, value: word.value.slice(0, at), refs, subs };
  if (word.typed !== undefined) cut.typed = word.typed.split("\0")[0] as string;
  if (refs.length > 0) return cut;
  delete cut.unquotedExpansion;
  return { ...cut, dynamic: false, computed: false };
}

function cutToken(token: Token): Token {
  if (token.type === "word") return cutWord(token);
  if (token.type === "subs") return { ...token, subs: token.subs.map(cutTokens) };
  if (token.type !== "redirect") return token;
  const cut: RedirectToken = { ...token, subs: token.subs.map(cutTokens) };
  if (token.target) cut.target = cutWord(token.target);
  return cut;
}

const cutTokens = (tokens: Token[]): Token[] => tokens.map(cutToken);

/**
 * The readings of text piped into a shell. bash, sh and dash drop NUL (TP-1460). zsh keeps it and an
 * exec'd word ends at its first one (TP-1464); ksh is not certain. zsh and ksh get both, so a protected
 * verdict from either reading stands. The raw reading must go through `readPiped`.
 */
export function pipedShellTexts(shell: string, stdin: string): string[] {
  if (!stdin.includes("\0")) return [stdin];
  const dropped = stdin.replaceAll("\0", "");
  return shell === "zsh" || shell === "ksh" ? [dropped, stdin] : [dropped];
}

/** Tokens of a piped script; each parsed word is cut at its first NUL, after quotes, escapes and substitutions are read. */
export function readPiped(text: string, wrap: string): Token[] {
  const tokens = tokenize(text);
  return wrap === "piped-shell" && text.includes("\0") ? cutTokens(tokens) : tokens;
}
