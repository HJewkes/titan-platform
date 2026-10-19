import type { AliasTable } from "./alias-words.js";
import type { RedirectToken, WordToken } from "./lexer.js";
import type { Descriptors } from "./shell-options.js";

/**
 * How a command was reached: a `( )` subshell or a substitution, a shell's `-c` string or a wrapper's
 * script option, `eval`, `xargs`, a heredoc or here-string fed to a shell, text piped into one, `find -exec`.
 */
export type Wrapping = "subshell" | "sh-c" | "eval" | "xargs" | "heredoc-shell" | "piped-shell" | "find-exec";

/** A run of commands joined only by `&&`; any other operator, a group or a nested list starts a new one. Compared by identity. */
export interface Chain {
  /** The operator before the run's first command, null at the start of a list. */
  readonly start: string | null;
}

/** One simple command the shell would run. */
export interface SimpleCommand {
  /** Null when no word names the command statically: only assignments or redirections, or a dynamic first word. */
  name: string | null;
  /** The command word as typed, after literal expansion (`./x.sh`, `~/bin/x`); null when `name` is. */
  path: string | null;
  args: WordToken[];
  /** Literal `NAME=value` prefixes. */
  env: Record<string, string>;
  redirects: RedirectToken[];
  /** Working directory, null when it cannot be known. */
  dir: string | null;
  /** The wrappings that reached the command, outermost first; empty at the top level. */
  wrapping: Wrapping[];
  /** The operator joining the command to the next on its list (`&&`, `||`, `;`, `\n`, `|`, `&`), null when none follows. */
  next: string | null;
  /** The operator joining the previous command on its list to this one, null when none precedes. */
  prev: string | null;
  /** Whether `!` negates the status of the pipeline the command is in. */
  negated: boolean;
  chain: Chain;
  /** Set when `PATH` or zsh's `path` had been written, or may have, by the time the command runs, or the command's own prefix writes it. */
  pathChanged?: true;
  /** Set on a command only an added xargs reading runs; it may add actions but never fails the line or moves its state. */
  added?: true;
  /** What its descriptors held before its own redirects, when a command that runs it set them up (`bash -c bash < f`). */
  inherited?: Descriptors;
}

export interface ExtractOptions {
  cwd?: string | null;
  /** Expands `~`, `$HOME` and a bare `cd`; null leaves them unknown. */
  home?: string | null;
  /** Reads every command word lower-cased, as a filesystem that finds `GIT` as git runs it; arguments stay as written. */
  foldCase?: boolean;
  /**
   * Command names classify reads other than by their arguments' default treatment: guarded programs, the names a
   * family adds a verdict for or exempts, interpreters and `source`. A reading of dynamic wrapper words is skipped only
   * when neither its name nor the command's as written is one. Omitted: every name.
   */
  guarded?: ReadonlySet<string>;
  /**
   * Past the budget of dynamic wrapper readings, read the rest as if it had none, as main does, instead of throwing
   * `ReadingLimitError`. For a script the line runs, which the user cannot split further.
   */
  stopPastCap?: boolean;
  aliases?: AliasTable;
  /** Called once the walk ends if it wrote `PATH` or zsh's `path` in a shell that outlives it, or may have. */
  onPathWrite?: (unsafe: boolean, dirs: string[]) => void;
  /** Read `&&` and `||` in a bare-start `[[` as test words: only for text the caller knows bash, zsh or ksh reads. */
  joinsConditional?: boolean;
  /** Called with each script text the walk reads (a `-c` string, eval text, a heredoc or piped script), before reading it. */
  onScript?: (text: string) => void;
  /** The text is the Bash tool's own line, run by bash or zsh, where `((x))` may be arithmetic; off, it reads as nested subshells that run `x`. */
  arithmetic?: boolean;
}
