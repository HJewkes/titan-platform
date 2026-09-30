import type { WordToken } from "./lexer.js";
import { basename } from "./path.js";
import { parseAssignment } from "./vars.js";

interface WrapperSpec {
  /** Options that take a separate value. */
  values?: string[];
  /** Options meaning "does not run the command". */
  stop?: string[];
  /** Positionals before the wrapped command. */
  positionals?: number;
}

const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "{", "}", "!"]);
const PACKAGE_OPTS: WrapperSpec = { values: ["-p", "--package"] };

const WRAPPERS: Record<string, WrapperSpec> = {
  env: { values: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"] },
  command: { stop: ["-v", "-V"] },
  builtin: {},
  exec: { values: ["-a"] },
  nohup: {},
  time: {},
  nice: { values: ["-n"] },
  sudo: { values: ["-u", "-g", "-p", "-C", "-D", "-h", "-r", "-t", "-U"] },
  timeout: { values: ["-s", "-k", "--signal", "--kill-after"], positionals: 1 },
  xargs: { values: ["-I", "-L", "-n", "-P", "-d", "-E", "-s", "-a"] },
  stdbuf: { values: ["-i", "-o", "-e"] },
  npx: PACKAGE_OPTS,
  bunx: PACKAGE_OPTS,
};

/** Package managers that run a command only through a subcommand: `pnpm exec x`, `yarn dlx x`, `npm exec x`. */
const RUNNERS: Record<string, { subs: string[]; values: string[] }> = {
  pnpm: { subs: ["exec", "dlx"], values: ["--filter", "-F", "-C", "--dir"] },
  yarn: { subs: ["exec", "dlx"], values: ["--cwd"] },
  npm: { subs: ["exec", "x"], values: ["-w", "--workspace", "-C", "--prefix"] },
};

export interface Unwrapped {
  /** The command that runs, or null when no word names one statically. */
  name: string | null;
  args: WordToken[];
  /** Leading `NAME=value` words, values null when only known at run time. */
  assigned: Array<[string, string | null]>;
}

/** Program name a command word runs: a path's basename, a scoped package whole, any `@version` dropped. */
export function commandName(value: string): string {
  if (value.startsWith("@")) return value.replace(/(?<=\/[^@]*)@.*$/, "");
  return basename(value).replace(/@.*$/, "");
}

/** Strips keywords, assignments and wrappers. Returns null for a wrapper that does not run its command. */
export function unwrap(words: WordToken[]): Unwrapped | null {
  const assigned: Array<[string, string | null]> = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i] as WordToken;
    const assignment = parseAssignment(w);
    if (KEYWORDS.has(w.value) && !w.quoted) i++;
    else if (assignment) {
      assigned.push(assignment);
      i++;
    } else if (!w.dynamic && wrapperSpec(w.value)) {
      i = skipWrapper(words, i + 1, wrapperSpec(w.value) as WrapperSpec);
      if (i < 0) return null;
    } else if (!w.dynamic && runnerEnd(words, i) > i) i = runnerEnd(words, i);
    else break;
  }
  const first = words[i];
  if (!first) return { name: null, args: [], assigned };
  if (first.dynamic) return { name: null, args: words.slice(i), assigned };
  return { name: commandName(first.value), args: words.slice(i + 1), assigned };
}

function wrapperSpec(value: string): WrapperSpec | undefined {
  const name = commandName(value);
  return Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : undefined;
}

function skipWrapper(words: WordToken[], i: number, spec: WrapperSpec): number {
  while (i < words.length && (words[i] as WordToken).value.startsWith("-")) {
    const v = (words[i] as WordToken).value;
    if (spec.stop?.includes(v)) return -1;
    i += spec.values?.includes(v) ? 2 : 1;
    if (v === "--") break;
  }
  return i + (spec.positionals ?? 0);
}

/** Index just past `pnpm [opts] exec [opts]` and the like, or `i` when the word at `i` is not such a runner. */
function runnerEnd(words: WordToken[], i: number): number {
  const name = commandName((words[i] as WordToken).value);
  const spec = Object.hasOwn(RUNNERS, name) ? RUNNERS[name] : undefined;
  if (!spec) return i;
  const sub = skipWrapper(words, i + 1, { values: spec.values });
  const subWord = words[sub];
  if (!subWord || subWord.dynamic || !spec.subs.includes(subWord.value)) return i;
  return skipWrapper(words, sub + 1, PACKAGE_OPTS);
}
