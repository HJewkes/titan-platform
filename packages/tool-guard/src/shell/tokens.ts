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
  /** A `$(` or backtick stands in the value as text the word spelled out, which bash evaluates wherever it reads the value as arithmetic. */
  codeText?: true;
  /** A `$` or backtick expansion sits outside double quotes, so it word-splits even when other parts are quoted. */
  unquotedExpansion?: true;
  refs: VarRef[];
  /** Token lists of command substitutions, which run even when quoted. */
  subs: Token[][];
  /** Where each `$( )` or backquote's output lands in `value`, which leaves it out, and which of `subs` it is. */
  cuts?: Array<{ at: number; sub: number }>;
  /** The text before literal variables were expanded into it; absent when nothing was expanded. */
  typed?: string;
  /** Set on a word variable tracking adds itself, never by the lexer; only such a word can assign a hidden slot. */
  hidden?: true;
  /** A `{name}` before a redirect: zsh reads it as the redirect's descriptor and dash as a word; bash only when glued. */
  namedFd?: "glued" | "spaced";
}

export interface OpToken {
  type: "op";
  value: string;
  /** Set on the first `(` of a `((` the lexer reads as an arithmetic command; absent on nested subshells. */
  arith?: true;
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
  /** The `{name}` word before the operator; in the reading that takes it as the descriptor, `fd` holds it too. */
  named?: string;
  target: WordToken | null;
  body: string | null;
  /** Command substitutions in an unquoted heredoc body, which the shell runs before the command. */
  subs: Token[][];
}

export type Token = WordToken | OpToken | SubsToken | RedirectToken;

/**
 * One open `case`: reading its subject word, its `in`, the start of a pattern list (where `esac` closes), a pattern
 * word after a leading `(` or a `|`, the rest of a pattern list, or a body, at the paren depth its `case` sat at. `amp` marks a `;` or `;;` that an `&` may complete, and
 * `blocks` counts the braces, `if`s and loops open in the body.
 */
export interface CaseFrame {
  phase: "subject" | "in" | "patterns" | "alternative" | "pattern" | "body" | "stuck";
  depth: number;
  amp: boolean;
  blocks: number;
}

/** Tokens scanned so far, their paren depth, and the depths a `[[` and a `=~` in it sat at, or -1. */
export interface RegexScan {
  scanned: number;
  depth: number;
  commandStart: boolean;
  conditionalAt: number;
  regexAt: number;
  /** The last word stood in command position, so a `(` after it may open a function header `name ( )`. */
  wordAtStart: boolean;
  /** The last words were `time` and its options, after which bash still reads a command. */
  timed: boolean;
  /** The last word was `function` or `coproc` in command position, so the next word is a name a `(` may follow. */
  nameNext: boolean;
  /** The last word named a function or coproc, so a `(` after it opens a header or a subshell body. */
  named: boolean;
  /** Open `case`s, innermost last. */
  cases: CaseFrame[];
  /** Open `if`s and loops, without which bash rejects `then`, `elif`, `else` and `do`. */
  blockDepth: number;
  /** Paren depth of an open function header `(`, or -1. */
  headerAt: number;
  /** A function header closed and its compound body has not opened, so bash accepts only that body next. */
  bodyPending: boolean;
}

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
  /** Index of the `]` of a subscript bash may join but this lexer splits; before it a comment or heredoc opener is refused. */
  looseSubscriptEnd: number;
  /** Whether the arithmetic command `arithEnd` closes began outside every loose span; a trial lex starts inside one. */
  arithOutsideLoose: boolean;
  /** Index of the `))` closing an arithmetic command; before it `<<` is a shift and `#` no comment. */
  arithEnd: number;
  /** Index of the first `(` of the arithmetic command `arithEnd` closes, or -1; the operator token there carries `arith`. */
  arithOpen: number;
  /** Index of the `)` matching a `((`'s second `(`, arithmetic or not; bash reads up to it whole, so no newline before it ends a line. */
  wholeEnd: number;
  /** Paren depth a `NAME=(` or `NAME+=(` opened at, or -1; bash rejects any redirect before that paren closes. */
  compoundDepth: number;
  /** A word spelled `case` or `esac` has been read; until then no case is open and the scan can wait. */
  caseWords: boolean;
  /** Where the scan for a `[[ … =~ … ]]` operand, which `NAME=(` only groups in, has reached. */
  regex: RegexScan;
  trials: ArithTrials;
}
