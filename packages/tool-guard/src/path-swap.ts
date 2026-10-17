import { mayBeWritten } from "./line-writes.js";
import { OpaqueShebangError } from "./scripts.js";
import { resolveValue } from "./shell/path.js";
import type { ClassifyContext } from "./types.js";

/** What a line does to the `PATH` an `env`-found shell is looked up through, settled over the whole line before any script is judged. */
export interface PathState {
  /** The line put a relative, empty or run-time entry on PATH, or wrote it in a way the walk cannot read. */
  unsafe: boolean;
  /** Absolute directories the line put on PATH; they change the shell only if the line writes one there. */
  dirs: string[];
  /** Paths whose first line has `env` find the shell. */
  viaEnv: Set<string>;
  /** By-path runs of any script, and whether the command's own prefix made PATH unsafe for it. */
  runs: Array<{ path: string; own: boolean }>;
  /** What each sourced script's text wrote to PATH, applied where the line sources it. */
  sourced: Map<string, { unsafe: boolean; dirs: string[] }>;
}

export function newPathState(): PathState {
  return { unsafe: false, dirs: [], viaEnv: new Set(), runs: [], sourced: new Map() };
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
