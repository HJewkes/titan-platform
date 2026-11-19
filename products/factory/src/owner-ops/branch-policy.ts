import { z } from "zod";

/** A delete-branch prefix ends in `/`, so no prefix can be empty or stand for a whole branch name. */
export const BranchPrefixSchema = z.string().regex(/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\/$/, "must be a branch prefix such as scratch/");

/** TP-3620 Q4: only scratch branches, until the owner widens the list in config. */
export const DEFAULT_BRANCH_PREFIXES: readonly string[] = Object.freeze(["scratch/"]);

/** The branches the console may delete and the repos it manages, both from factory config; absent, every delete is refused. */
export interface BranchDeletePolicy {
  prefixes: readonly string[];
  repos: readonly string[];
}
