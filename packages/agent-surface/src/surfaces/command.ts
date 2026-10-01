/**
 * The one command every surface launches, supplied by the host as a `Launcher`.
 *
 * A surface never sees `plan.bin` or `plan.args`. The plan is already on disk and
 * the launcher is what reads it, which keeps a model-authored brief out of every
 * command line: AppleScript only ever carries a fixed string with an agent id in it.
 */
export interface Launcher {
  /** The full argv that starts one agent; `argv[0]` is the executable. */
  argv(agentId: string): string[];
  /**
   * Variables a pane's shell must be handed explicitly. A pane opens in a fresh
   * login shell with the user's environment, not the host's, so a relocated
   * state directory is invisible to it unless carried here.
   */
  env?: Record<string, string>;
  /** Where the in-place relaunch script for this agent lives; only a reused pane types it. */
  relaunchPath(agentId: string): string;
}

/** Single-quoted for /bin/sh: paths here are ours, but they can still hold spaces. */
export const shellQuote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

const envWords = (launcher: Launcher): string[] =>
  Object.entries(launcher.env ?? {}).map(([name, value]) => `${name}=${shellQuote(value)}`);

/** For surfaces that hand a shell a line to type, rather than spawning argv directly. */
export const launchCommand = (launcher: Launcher, agentId: string): string =>
  [...envWords(launcher), ...launcher.argv(agentId).map(shellQuote)].join(" ");

/**
 * One word of iTerm2's `command` parameter, which iTerm splits into argv itself
 * (`componentsInShellCommand`), with no shell and its own escape rules: `\n`,
 * `\t`, `\a` and `\r` become control characters even inside single quotes, and
 * the string is first evaluated as an interpolated "swifty" string where `\(`
 * starts an expression. So a word is double-quoted and may hold no backslash
 * and no double quote at all, rather than trusting an escape to survive both.
 */
const itermWord = (word: string): string => {
  if (/["\\]/.test(word))
    throw new Error(`cannot hand iTerm2 a command containing a double quote or backslash: ${word}`);
  return `"${word}"`;
};

/**
 * For a pane the host opens: the command is given to iTerm at creation, so it is
 * never typed into a shell whose input the human can reach.
 *
 * `zsh -lic` for the environment a typed command used to get: `-l` for PATH from
 * .zprofile, `-i` for whatever .zshrc exports. `exec /bin/zsh -l` afterwards
 * keeps the pane, and whatever the launcher printed, open after it exits or crashes.
 */
export const paneCommand = (launcher: Launcher, agentId: string): string =>
  ["/bin/zsh", "-lic", `${launchCommand(launcher, agentId)}; exec /bin/zsh -l`].map(itermWord).join(" ");

/**
 * The only thing still typed into a shell: a reused pane has no creation
 * `command` to take, so it gets this short fixed path instead of the full
 * command line. Keys that join it in front make it a different, failing command;
 * keys typed between it and the newline become arguments, which a correct
 * invocation never has.
 */
export const relaunchCommand = (launcher: Launcher, agentId: string): string =>
  shellQuote(launcher.relaunchPath(agentId));

/** The script `relaunchCommand` runs; the host writes it to `launcher.relaunchPath(agentId)`. */
export const relaunchScript = (launcher: Launcher, agentId: string): string =>
  [
    "#!/bin/sh",
    'if [ "$#" -ne 0 ]; then',
    `  echo "not relaunching ${agentId}: typed keys joined the command (extra arguments: $*)" >&2`,
    "  exit 64",
    "fi",
    ...envWords(launcher).map(word => `export ${word}`),
    `exec ${launcher.argv(agentId).map(shellQuote).join(" ")}`,
    "",
  ].join("\n");
