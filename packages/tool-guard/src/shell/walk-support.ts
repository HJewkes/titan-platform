import type { WordToken } from "./lexer.js";
import { resolvePath } from "./path.js";
import { SHELLS } from "./inline-script.js";
import type { ExtractOptions } from "./commands.js";
import type { Unwrapped } from "./unwrap.js";
import { MAX_UNSURE_WORDS, SPLICED_WEIGHT } from "./unsure-readings.js";
import type { UnsureBudget } from "./unsure-readings.js";

const RUNNERS = new Set([...SHELLS, "eval", "emulate", "find"]);

/** The line's budget of `unsure` reading words and spliced text, shared by every walk of it. */
export function lineBudget(src: string, options: ExtractOptions): UnsureBudget {
  return {
    left: MAX_UNSURE_WORDS,
    splicedLeft: SPLICED_WEIGHT * src.length,
    decides: decider(options.guarded),
    stopPastCap: options.stopPastCap === true,
  };
}

/** A dynamic or guarded command word, or one that runs more commands: shell text, a `.sh` script, `xargs` or `find -exec`. */
function decider(guarded: ReadonlySet<string> | undefined): (cmd: Unwrapped) => boolean {
  return (cmd) => cmd.name === null || cmd.xargs !== undefined || cmd.script !== undefined || RUNNERS.has(cmd.name) || cmd.name.endsWith(".sh") || (guarded?.has(cmd.name) ?? true);
}

export function literalEnv(cmd: Unwrapped): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value, kind] of cmd.assigned) if (value !== null && !kind) env[name] = value;
  return env;
}

export function changeDir(dir: string | null, word: WordToken | undefined, home: string | null): string | null {
  if (!word) return home;
  return word.value === "-" ? null : resolvePath(dir, word, home);
}
