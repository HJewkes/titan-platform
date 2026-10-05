import type { WordToken } from "./lexer.js";

/**
 * Every long option each wrapper's getopt_long accepts; it also takes any unambiguous prefix of one.
 * An option missing here can make a real ambiguity look unambiguous, so keep each list complete.
 */
const LONG_OPTIONS: Record<string, string[]> = {
  // findutils xargs(1)
  xargs: [
    "null", "arg-file", "delimiter", "eof", "replace", "max-lines", "max-args", "open-tty", "interactive",
    "no-run-if-empty", "max-chars", "verbose", "show-limits", "exit", "max-procs", "process-slot-var", "version", "help",
  ],
  // GNU coreutils timeout(1)
  timeout: ["foreground", "kill-after", "preserve-status", "signal", "verbose", "help", "version"],
  // GNU coreutils nice(1)
  nice: ["adjustment", "help", "version"],
  // GNU coreutils env(1)
  env: [
    "ignore-environment", "null", "unset", "chdir", "split-string", "block-signal", "default-signal", "ignore-signal",
    "list-signal-handling", "debug", "argv0", "help", "version",
  ],
  // GNU coreutils stdbuf(1)
  stdbuf: ["input", "output", "error", "help", "version"],
  // GNU coreutils nohup(1)
  nohup: ["help", "version"],
  // sudo(8)
  sudo: [
    "askpass", "auth-type", "background", "bell", "close-from", "chdir", "preserve-env", "edit", "group", "set-home",
    "help", "host", "login", "login-class", "remove-timestamp", "reset-timestamp", "list", "non-interactive",
    "preserve-groups", "prompt", "chroot", "role", "stdin", "shell", "command-timeout", "type", "other-user", "user",
    "version", "validate",
  ],
  // util-linux flock(1)
  flock: [
    "shared", "exclusive", "unlock", "nonblock", "nb", "timeout", "wait", "conflict-exit-code", "close", "no-fork",
    "verbose", "command", "help", "version",
  ],
  // procps-ng watch(1)
  watch: [
    "beep", "color", "no-color", "differences", "equexit", "chgexit", "exec", "precise", "no-rerun", "no-title",
    "no-wrap", "errexit", "interval", "shotsdir", "help", "version",
  ],
  // GNU time(1)
  time: ["append", "format", "help", "output", "portability", "quiet", "verbose", "version"],
};

/**
 * Every short option each wrapper takes a separate value with, across the implementations named.
 * A missing one makes its value read as the command, which hides the command that really runs.
 */
export const SHORT_VALUES = {
  // sudo(8)
  sudo: ["-a", "-c", "-C", "-D", "-g", "-h", "-p", "-R", "-r", "-T", "-t", "-U", "-u"],
  // GNU coreutils env(1) -a -C -u (-S is a script option); BSD env(1) -P; FreeBSD env(1) -L -U
  env: ["-a", "-C", "-u", "-P", "-L", "-U"],
  // GNU coreutils timeout(1)
  timeout: ["-s", "-k"],
  // GNU coreutils and BSD nice(1)
  nice: ["-n"],
  // GNU coreutils stdbuf(1)
  stdbuf: ["-i", "-o", "-e"],
  // util-linux flock(1) (-c is a script option)
  flock: ["-w", "-E"],
  // procps-ng watch(1)
  watch: ["-n", "-q", "-s"],
  // OpenBSD doas(1) (-C only checks a config)
  doas: ["-a", "-u"],
  // findutils xargs(1) -I -L -n -P -d -E -s -a; BSD xargs(1) -J -R -S
  xargs: ["-I", "-L", "-n", "-P", "-d", "-E", "-s", "-a", "-J", "-R", "-S"],
  // GNU time(1); FreeBSD time(1) -o
  time: ["-f", "-o"],
};

/** The sudo long options that take a separate value. */
export const SUDO_LONG_VALUES = ["--user", "--group", "--prompt", "--close-from", "--chdir", "--host", "--role", "--type", "--other-user", "--auth-type", "--chroot", "--command-timeout", "--login-class"];

/** The long option `v` abbreviates, spelled out with any `=value` kept; null when the prefix fits several. */
function fullOption(v: string, options: string[]): string | null {
  const eq = v.indexOf("=");
  const name = v.slice(2, eq < 0 ? undefined : eq);
  if (options.includes(name)) return v;
  const matches = options.filter((o) => o.startsWith(name));
  if (matches.length > 1) return null;
  return matches.length === 1 ? `--${matches[0]}${eq < 0 ? "" : v.slice(eq)}` : v;
}

/** The words with each long option of `wrapper` from `start` on spelled out, or the index of an ambiguous one. */
export function spellLongOptions(
  wrapper: string,
  words: WordToken[],
  start: number,
  takesValue: (v: string) => boolean,
): WordToken[] | number {
  const options = Object.hasOwn(LONG_OPTIONS, wrapper) ? LONG_OPTIONS[wrapper] : undefined;
  if (!options) return words;
  const out = [...words];
  for (let j = start; j < out.length && (out[j] as WordToken).value.startsWith("-") && (out[j] as WordToken).value !== "--"; j++) {
    const word = out[j] as WordToken;
    const full = word.value.startsWith("--") && !word.dynamic ? fullOption(word.value, options) : word.value;
    if (full === null) return j;
    out[j] = { ...word, value: full };
    if (takesValue(full)) j++;
  }
  return out;
}
