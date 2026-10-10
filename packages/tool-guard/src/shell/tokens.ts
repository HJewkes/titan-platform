import type { ArithTrials } from "./arith-trials.js";

/** A `$NAME` or `${NAME}` reference; `start` and `end` index into the word's `value`. */
export interface VarRef {
  name: string;
  start: number;
  end: number;
}

/**
 * One shell word with quotes removed. `dynamic` means its value is only known at run time;
 * `computed` means some of that comes from something other than a plain variable reference.
 */
export interface WordToken {
  type: "word";
  value: string;
  dynamic: boolean;
  quoted: boolean;
  /** Quotes or escapes split the word, or `$'...'` decoded it: `~/".x"`, `.n''x`, `.n\x`. */
  spliced: boolean;
  computed: boolean;
  /** A `$` or backtick expansion sits outside double quotes, so it word-splits even when other parts are quoted. */
  unquotedExpansion?: true;
  refs: VarRef[];
  /** Token lists of command substitutions, which run even when quoted. */
  subs: Token[][];
  /** The text before literal variables were expanded into it; absent when nothing was expanded. */
  typed?: string;
  /** Set on a word variable tracking adds itself, never by the lexer; only such a word can assign a hidden slot. */
  hidden?: true;
}

export interface OpToken {
  type: "op";
  value: string;
}

/** Process substitutions, `<(...)` and `>(...)`. */
export interface SubsToken {
  type: "subs";
  subs: Token[][];
}

/** `target` is the word after the operator; for a heredoc it is the delimiter and `body` is the text. */
export interface RedirectToken {
  type: "redirect";
  op: string;
  fd: string | null;
  target: WordToken | null;
  body: string | null;
  /** Command substitutions in an unquoted heredoc body, which the shell runs before the command. */
  subs: Token[][];
}

export type Token = WordToken | OpToken | SubsToken | RedirectToken;

export interface LexState {
  src: string;
  i: number;
  nested: boolean;
  depth: number;
  tokens: Token[];
  word: WordToken | null;
  heredocs: Array<{ token: RedirectToken; stripTabs: boolean }>;
  /** A `$( )` or `<( )` closed on this line with a heredoc still open. */
  leftOpen: boolean;
  redirect: { token: RedirectToken; stripTabs: boolean } | null;
  /** Index of the `]` closing an assignment's subscript; blanks and operators before it stay in the word. */
  subscriptEnd: number;
  /** Index of the `))` closing an arithmetic command; before it `<<` is a shift and `#` no comment. */
  arithEnd: number;
  trials: ArithTrials;
}
