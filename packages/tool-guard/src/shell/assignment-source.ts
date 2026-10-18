import type { Assignment } from "./vars.js";
import type { WordToken } from "./tokens.js";

/**
 * Hidden key in a scope's variables: whether the `PATH` the line set may list the working directory. It holds only
 * `NO_CWD` or a value that means it may (null after a store the walk cannot read); no entry text is kept in it.
 */
export const SEARCH_KEY = "searchpath@";
export const NO_CWD = "no-cwd";
export const MAY_LIST_CWD = "cwd";

/** What a `PATH` assignment's word said, which an assignment holds as null when the value is dynamic. */
export interface AssignmentSource {
  text: string;
  subs: boolean;
}

const sources = new WeakMap<Assignment, AssignmentSource>();

/** Remembers the typed value of an assignment to `PATH` or zsh's `path`, the only ones whose text the search path reads. */
export function recordSource(assignment: Assignment, word: WordToken): void {
  if (assignment[0] !== "PATH" && assignment[0] !== "path") return;
  sources.set(assignment, { text: word.value.slice(word.value.indexOf("=") + 1), subs: word.subs.length > 0 });
}

export function sourceOf(assignment: Assignment): AssignmentSource | undefined {
  return sources.get(assignment);
}
