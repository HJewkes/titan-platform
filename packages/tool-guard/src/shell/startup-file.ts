import type { Token, WordToken } from "./tokens.js";

/**
 * Variables that name a file a starting shell sources: bash's `BASH_ENV`, sh's `ENV`, zsh's `ZDOTDIR`, and `HOME`,
 * under which zsh always reads `.zshenv` and a login bash or zsh reads its profile.
 */
export const STARTUP_VAR_RE = /^(?:BASH_ENV|ENV|ZDOTDIR|HOME)(?:\[[^\]]*\])?(?:\+?=|$)/;
/** Each startup variable's shortest spelling; `BASH_ENV` holds `ENV` in order. */
const STARTUP_NAMES = ["ENV", "ZDOTDIR", "HOME"];
/** Shell options that source a startup file: interactive or login clusters, and an rc or init file. */
export const STARTUP_OPTION_RE = /^(?:-[A-Za-z]*[il][A-Za-z]*|--login|--rcfile|--init-file|--interactive)$/;
/** Option words known to leave a shell's startup alone; `-o` is not one, since zsh's `-o login` makes a login shell. */
const PLAIN_OPTION_RE = /^(?:-[cefnsuvx]+|--)$/;
const SHELL_NAME_RE = /^(?:sh|bash|zsh|dash|ksh|mksh)$/;

/** The tokens and every token list nested in their command and process substitutions. */
export function tokenLists(tokens: readonly Token[]): Token[][] {
  const nested = tokens.flatMap((t): Token[][] => {
    if (t.type === "word" || t.type === "subs") return t.subs;
    if (t.type === "redirect") return [...t.subs, ...(t.target?.subs ?? [])];
    return [];
  });
  return [[...tokens], ...nested.flatMap(tokenLists)];
}

/**
 * Whether any word of the line, nested lists included, sets or exports a startup-file variable. A shell started
 * anywhere after it sources that file before its own script, as `source` would.
 */
export function selectsStartupFile(tokens: readonly Token[]): boolean {
  return tokenLists(tokens).some((list) => list.some((t) => t.type === "word" && namesStartupVar(t.value)));
}

/**
 * Whether the line may make a shell source a file before its script: a startup-file variable, or a list that names a
 * shell beside any option word not known to be plain (`bash -l`, `--init-file f`, `exec -a -bash bash`).
 */
export function choosesStartup(tokens: readonly Token[]): boolean {
  if (selectsStartupFile(tokens)) return true;
  return tokenLists(tokens).some((list) => {
    const words = list.filter((t): t is WordToken => t.type === "word");
    return words.some(namesShell) && !plainShellOptions(words.filter((w) => /^[-+]/.test(w.value)));
  });
}

/** Whether a shell's option words leave its startup alone, so it reads no file before its script that the line chose. */
export function plainShellOptions(options: readonly WordToken[]): boolean {
  return options.every((w) => !w.dynamic && !w.computed && PLAIN_OPTION_RE.test(w.value));
}

function namesShell(word: WordToken): boolean {
  return SHELL_NAME_RE.test(word.value.slice(word.value.lastIndexOf("/") + 1));
}

/**
 * Brace expansion keeps a word's characters in order, so a brace word builds a startup variable's name
 * (`{BASH_,}ENV=./f`) only if it holds that name in order, unless a `..` range makes the letters.
 */
function namesStartupVar(value: string): boolean {
  if (STARTUP_VAR_RE.test(value)) return true;
  if (!value.includes("{")) return false;
  return value.includes("..") || STARTUP_NAMES.some((name) => holdsInOrder(value, name));
}

function holdsInOrder(text: string, name: string): boolean {
  let at = -1;
  for (const c of name) {
    at = text.indexOf(c, at + 1);
    if (at < 0) return false;
  }
  return true;
}
