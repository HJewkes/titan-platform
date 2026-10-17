import type { Assignment } from "./vars.js";
import type { WordToken } from "./tokens.js";

/** Hidden key in a scope's variables: the entries of the `PATH` the line set, joined by `:`; null once a store the walk cannot read touched it. */
export const SEARCH_KEY = "searchpath@";
/** An entry whose directory only run time knows. */
export const UNKNOWN_ENTRY = "$?";

/** An entry a run-time `eval` may have added: probably the working directory, but only a file there is read. */
export const SOFT_ENTRY = "@soft";

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
