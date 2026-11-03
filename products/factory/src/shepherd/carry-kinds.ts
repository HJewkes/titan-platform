/** Kinds whose reviewed MERGE a tree-equal update may reuse; a security change always gets a fresh reviewer. */
export const CARRYING_KINDS: ReadonlySet<string> = new Set(["correctness", "feature", "refactor"]);
