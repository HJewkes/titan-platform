import { mayBeWritten } from "./line-writes.js";
import { OpaqueShebangError } from "./scripts.js";
import { resolveValue } from "./shell/path.js";
import type { ClassifyContext } from "./types.js";

/** A by-path run of a script, and whether the command that ran it, or one that launched its shell, had PATH in its own prefix. */
export interface PathRun {
  path: string;
  own: boolean;
}

/**
 * What one shell's text does to the `PATH` an `env`-found shell is looked up through, settled over the whole text
 * before any script is judged. A script the text runs gets a state of its own; the caller takes its runs, which inherit
 * the caller's PATH, and, only when it sources the script, its writes.
 */
export interface PathState {
  /** The text put a relative, empty or run-time entry on PATH, or wrote it in a way the walk cannot read. */
  unsafe: boolean;
  /** Absolute directories the text put on PATH; they change the shell only if the line writes one there. */
  dirs: string[];
  /** Paths whose first line has `env` find the shell; a property of the file, so shared by every state of one line. */
  viaEnv: Set<string>;
  /** By-path runs in this shell and in every script it runs. */
  runs: PathRun[];
}

export function newPathState(): PathState {
  return { unsafe: false, dirs: [], viaEnv: new Set(), runs: [] };
}

/** The state of a script's own shell, which starts with no writes of its own. */
export function scriptPathState(caller: PathState): PathState {
  return { ...newPathState(), viaEnv: caller.viaEnv };
}

/** Takes what the script whose state is `script` did into its caller's state, where the command `ownPath` launched it. */
export function takeScriptPath(caller: PathState, script: PathState, sourced: boolean, ownPath: boolean): void {
  if (sourced) addPathWrite(caller, script.unsafe, script.dirs);
  caller.runs.push(...script.runs.map((run) => ({ path: run.path, own: run.own || ownPath })));
}

export function addPathWrite(state: PathState, unsafe: boolean, dirs: string[]): void {
  state.unsafe ||= unsafe;
  state.dirs.push(...dirs);
}

const SHELLS = ["bash", "sh", "zsh"];

/** Whether the line may write a shell into a directory it put on PATH, as far as `line` (its state after the last command) shows. */
function writesIntoPathDir(state: PathState, line: ClassifyContext): boolean {
  return state.dirs.some((dir) => {
    const base = resolveValue(null, dir, line.home);
    return base === null || SHELLS.some((shell) => mayBeWritten(line, `${base}/${shell}`));
  });
}

/** Refuses a by-path script with an `env`-form `#!` once the whole line is known to have changed which shell `env` finds. */
export function refuseSwappedShells(state: PathState, line: ClassifyContext): void {
  const changed = state.unsafe || writesIntoPathDir(state, line);
  for (const run of state.runs) if ((changed || run.own) && state.viaEnv.has(run.path)) throw new OpaqueShebangError();
}
