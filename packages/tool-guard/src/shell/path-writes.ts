import { fixedHome } from "./path-entries.js";
import type { Vars } from "./vars.js";

/** The variables `env` and the shell search for a program by: bash's `PATH` and zsh's `path` array tied to it. */
const PATH_NAMES = new Set(["PATH", "path"]);

/**
 * Hears what a scope's writes do to the search path: the absolute directories a path variable gains, or null when it
 * may gain any, and a `HOME` a `~` on PATH may name the working directory under.
 */
export interface PathObserver {
  dirs: (dirs: string[] | null) => void;
  homeUnfixed: () => void;
}

const pathObservers = new WeakMap<Vars, PathObserver>();

export function observePath(vars: Vars, observer: PathObserver): void {
  pathObservers.set(vars, observer);
}

/** Whether a name is one the shell finds programs through. */
export function isPathName(name: string): boolean {
  return PATH_NAMES.has(name);
}

/**
 * Reports a write that stored `stored` in `name`. A function body is walked where it is written, before a later `HOME=`
 * that runs first, so any `HOME` the line may give a run-time value is heard, wherever it falls.
 */
export function notePathWrite(vars: Vars, name: string, stored: string | null | undefined, dirs: string[] | null): void {
  if (PATH_NAMES.has(name)) pathObservers.get(vars)?.dirs(dirs);
  else if (name === "HOME" && !fixedHome(stored)) pathObservers.get(vars)?.homeUnfixed();
}

/** Every value is forgotten, so PATH may hold anything. */
export function notePathForgotten(vars: Vars): void {
  pathObservers.get(vars)?.dirs(null);
}
