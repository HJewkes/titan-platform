import type { Token, WordToken } from "./lexer.js";
import { NAMEREF_DECLARERS } from "./name-slots.js";

/** Words of a line on which nothing rebinds a command name, so `wc` there is the program found on PATH. */
const pathWords = new WeakSet<WordToken>();

/** Whether the word sits on a line where the commands it names are surely the programs on PATH. */
export const onPathLine = (w: WordToken) => pathWords.has(w);

/** Carries the mark to a copy of the word, as expanding a variable into it makes. */
export function carryPathLine(from: WordToken, to: WordToken): void {
  if (pathWords.has(from)) pathWords.add(to);
}

/** Commands that bind or define a name, or run text that may; any of them, or a function named `wc`, rules out PATH. */
const BINDERS = new Set(["alias", "hash", "eval", "source", ".", "enable", "functions", "autoload", "compdef"]);
const WRAPPERS = new Set(["builtin", "command", "time", "exec", "noglob", "nocorrect", "!", "{", "then", "do", "else", "elif"]);
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
const PATH_ASSIGNMENT_RE = /^(PATH|path|BASH_CMDS|commands)(\[[^\]]*\])?\+?=/;
const FUNCTION_NAME = "wc";

/**
 * Marks every word of the line, substitutions included, when no function, alias, `hash` binding, `PATH` change or
 * run-time text on the line can rebind `wc`. Fails closed: any doubt leaves the words unmarked.
 */
export function notePathLine(tokens: Token[]): Token[] {
  const words: WordToken[] = [];
  if (!rebindsAny(tokens, words)) for (const w of words) pathWords.add(w);
  return tokens;
}

function rebindsAny(tokens: Token[], words: WordToken[]): boolean {
  let start = true;
  let found = false;
  for (const [i, t] of tokens.entries()) {
    if (t.type === "redirect") {
      for (const sub of t.target?.subs ?? []) found = rebindsAny(sub, words) || found;
      continue;
    }
    if (t.type === "subs") {
      for (const sub of t.subs) found = rebindsAny(sub, words) || found;
      continue;
    }
    if (t.type === "op") {
      const next = tokens[i + 1];
      if (t.value === "(" && next?.type === "op" && next.value === ")") found ||= namesWc(tokens[i - 1]);
      start = t.value !== ")";
      continue;
    }
    words.push(t);
    for (const sub of t.subs) found = rebindsAny(sub, words) || found;
    if (PATH_ASSIGNMENT_RE.test(t.value)) found = true;
    if (start && ASSIGNMENT_RE.test(t.value)) continue;
    if (start) found ||= t.dynamic || BINDERS.has(t.value) || declaresNameref(t.value, tokens.slice(i + 1));
    if (t.value === "function") found ||= namesWc(tokens[i + 1]);
    start = start && WRAPPERS.has(t.value);
  }
  return found;
}

const namesWc = (t: Token | undefined) => t?.type === "word" && (t.value === FUNCTION_NAME || t.dynamic || t.quoted || t.spliced);

/**
 * A nameref may make `PATH` writable under another name (`declare -n r=PATH; r=/tmp/x`), so a declarer that may carry
 * `-n` voids the mark: a literal cluster holding `n`, or a word that may expand to an option.
 */
function declaresNameref(name: string, rest: Token[]): boolean {
  if (!NAMEREF_DECLARERS.has(name)) return false;
  const end = rest.findIndex((t) => t.type === "op");
  const args = (end < 0 ? rest : rest.slice(0, end)).filter((t): t is WordToken => t.type === "word");
  return args.some((a) => /^[-+][A-Za-z0-9]*n/.test(a.value) || (a.dynamic && (/^[$`]/.test(a.value) || (a.cuts ?? []).some((c) => c.at === 0))));
}
