import type { SimpleCommand } from "../shell/commands.js";
import type { WordToken } from "../shell/lexer.js";
import { resolveValue } from "../shell/path.js";
import type { ClassifyContext } from "../types.js";

/** The console's own CLI script, run from a checkout or an installed package rather than through its bin. */
const CONSOLE_SCRIPT_RE = /(?:^|\/)(?:titan-)?console\/(?:server\/cli\.[cm]?[jt]s|dist\/cli\.[cm]?js)$/;
/** With no known cwd a relative script could sit in any directory, so any `cli` script counts, named with or without its extension. */
const UNPLACED_SCRIPT_RE = /(?:^|\/)cli(?:\.[cm]?[jt]s)?\/?$/;
/** Eval text that loads the console's CLI by path or package name. */
const EVAL_LOADS_RE = /(?:titan-)?console\/(?:server|dist)\/cli\b/;
/** What node and tsx try after the name as typed: `node dist/cli` runs `dist/cli.js`, `node dist` its `index.js`. */
const RESOLVED_SUFFIXES = ["", ...["js", "mjs", "cjs", "ts", "mts", "cts"].flatMap((ext) => [`.${ext}`, `/index.${ext}`])];
export const SCRIPT_RUNNERS = new Set(["node", "tsx", "bun", "deno", "ts-node"]);

/** Options whose value is a module the runner loads and runs before the entry script. */
const PRELOADS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader"]);
const EVALS = new Set(["-e", "--eval", "-p", "--print"]);
/** Other node options that take the next word as their value, so it is never read as the entry script. */
const VALUED = new Set(["-C", "--conditions", "--env-file", "--input-type", "--title", "--inspect-port", "--disable-warning", "--watch-path"]);

/**
 * The argument lists the console may receive when a runner such as node starts it: after the console script wherever it
 * sits (`node dist/cli.js x`, `bun run dist/cli`), and after the entry when a preload, eval text or stdin runs the
 * console instead (`node -r ./dist/cli.js - x`), as its `process.argv.slice(2)`. The words right after the options are
 * also read, since an option this parser does not know may have taken one of them.
 */
export function runnerReadings(cmd: SimpleCommand, ctx: ClassifyContext): WordToken[][] {
  const dir = cmd.movesDir ? null : cmd.dir;
  const isConsole = (value: string) => isConsoleScript(value, dir, ctx);
  const readings = cmd.args.flatMap((a, i) => (!a.dynamic && isConsole(a.value) ? [cmd.args.slice(i + 1)] : []));
  const { loaded, rest } = optionRun(cmd.args, isConsole);
  const fromStdin = cmd.redirects.some((r) => r.op === "<" && (r.fd === null || r.fd === "0") && r.target !== null && !r.target.dynamic && isConsole(r.target.value));
  return loaded || fromStdin ? [...readings, rest, rest.slice(1)] : readings;
}

/** Node's options before the entry script, read by position: whether one loads the console, and the words after them all. */
function optionRun(args: readonly WordToken[], isConsole: (value: string) => boolean): { loaded: boolean; rest: WordToken[] } {
  let loaded = false;
  let i = 0;
  for (let word = args[0]; word !== undefined; word = args[++i]) {
    if (word.value === "--") return { loaded, rest: args.slice(i + 1) };
    if (word.dynamic || !word.value.startsWith("-") || word.value === "-") break;
    const { name, value, attached } = optionValue(word, args[i + 1]);
    // A value only known at run time may name the console, as may eval text that loads it.
    const unknown = value === null || value.dynamic;
    if (PRELOADS.has(name)) loaded ||= unknown || isConsole(value.value);
    if (EVALS.has(name)) loaded ||= unknown || EVAL_LOADS_RE.test(value.value);
    if (!attached && (PRELOADS.has(name) || EVALS.has(name) || VALUED.has(name))) i++;
  }
  return { loaded, rest: args.slice(i) };
}

/** `--require=./x.js` holds its value; `-r ./x.js` takes the next word. */
function optionValue(word: WordToken, next: WordToken | undefined): { name: string; value: WordToken | null; attached: boolean } {
  const eq = word.value.indexOf("=");
  if (eq < 0 || !word.value.startsWith("--")) return { name: word.value, value: next ?? null, attached: false };
  return { name: word.value.slice(0, eq), value: { ...word, value: word.value.slice(eq + 1) }, attached: true };
}

/** Tested where the runner finds it: resolved from the command's cwd with node's implicit suffixes, and through a symlink. */
function isConsoleScript(value: string, dir: string | null, ctx: ClassifyContext): boolean {
  const path = resolveValue(dir, value, ctx.home);
  if (path === null) return UNPLACED_SCRIPT_RE.test(value);
  const base = path.replace(/\/+$/, "");
  return RESOLVED_SUFFIXES.some((suffix) => {
    const candidate = base + suffix;
    const real = ctx.readLink(candidate);
    return CONSOLE_SCRIPT_RE.test(candidate) || (real !== null && CONSOLE_SCRIPT_RE.test(real));
  });
}
