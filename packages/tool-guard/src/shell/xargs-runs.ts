import type { WordToken } from "./lexer.js";
import { unwrap } from "./unwrap.js";
import type { Unwrapped } from "./unwrap.js";

/** Whether unwrap consumed a wrapper (`env`, `sudo`, `nice -n 5`) between xargs and the command it resolved. */
function runsWrapper(cmd: Unwrapped, words: WordToken[]): boolean {
  return words.length - cmd.args.length > (cmd.name === null ? 0 : 1);
}

/** A record with blanks may hold several words (`-0` input), so the run is also read with each split, which only adds commands to classify. */
function withSpread(words: WordToken[]): WordToken[][] {
  if (!words.some((w) => /\s/.test(w.value))) return [words];
  const spread = words.flatMap((w) => (/\s/.test(w.value) ? w.value.split(/\s+/).filter(Boolean).map((value) => ({ ...w, value })) : [w]));
  return [words, spread];
}

/**
 * The commands `xargs` runs. When a wrapper sits between xargs and its command, the piped words
 * belong after the wrapper, so each run's whole word list goes through `unwrap` again and resolves
 * as a direct call would. `runsOf` gives the argument lists a run takes from the input.
 */
export function xargsCommands(raw: Unwrapped, stdin: string | null, runsOf: (cmd: Unwrapped) => WordToken[][]): Unwrapped[] {
  return resolvedRuns(raw, stdin, runsOf).flatMap(withDynamicName);
}

function resolvedRuns(raw: Unwrapped, stdin: string | null, runsOf: (cmd: Unwrapped) => WordToken[][]): Unwrapped[] {
  const xargs = raw.xargs;
  if (!xargs || stdin === null || !runsWrapper(raw, xargs.words)) return runsOf(raw).map((args) => ({ ...raw, args }));
  return runsOf({ ...raw, args: xargs.words }).flatMap(withSpread).flatMap((words) => {
    const run = unwrap(words);
    return run ? [{ ...run, assigned: [...raw.assigned, ...run.assigned], xargs, ...(raw.negated ? { negated: true as const } : {}) }] : [];
  });
}

/**
 * A dynamic command word (`xargs "$G" push origin HEAD:main`) may name git, so the run is also read as
 * git with that word as its subcommand, which fails closed as `git "$X"` does.
 */
function withDynamicName(run: Unwrapped): Unwrapped[] {
  if (!run.xargs || run.name !== null || !run.args[0]?.dynamic) return [run];
  return [run, { ...run, name: "git", path: "git" }];
}
