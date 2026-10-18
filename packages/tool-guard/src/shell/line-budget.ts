import type { ExtractOptions } from "./commands.js";
import { SHELLS } from "./inline-script.js";
import { namesScript } from "./search-path.js";
import { MAX_UNSURE_WORDS, SPLICED_WEIGHT } from "./unsure-readings.js";
import type { UnsureBudget } from "./unsure-readings.js";
import type { Unwrapped } from "./unwrap.js";

const RUNNERS = new Set([...SHELLS, "eval", "emulate", "find"]);

/** The line's budget of `unsure` reading words and spliced text, shared by every walk of it. */
export function lineBudget(src: string, options: Pick<ExtractOptions, "guarded" | "stopPastCap">): UnsureBudget {
  return {
    left: MAX_UNSURE_WORDS,
    splicedLeft: SPLICED_WEIGHT * src.length,
    decides: decider(options.guarded),
    stopPastCap: options.stopPastCap === true,
  };
}

/** A dynamic or guarded command word, or one that runs more commands: shell text, a script named by path or `.sh`, `xargs` or `find -exec`. */
function decider(guarded: ReadonlySet<string> | undefined): (cmd: Unwrapped) => boolean {
  return (cmd) => cmd.name === null || cmd.xargs !== undefined || cmd.script !== undefined || RUNNERS.has(cmd.name) || namesScript(cmd) || (guarded?.has(cmd.name) ?? true);
}
