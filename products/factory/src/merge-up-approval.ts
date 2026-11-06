import { RESOLVER_CLASSES } from "@titan-design/authority";
import { z } from "zod";

const OWNER_CLASSES: readonly string[] = RESOLVER_CLASSES;

/**
 * Owner decision 556(3) (2026-11-06, TP-4791), on rule 461 ("merge-ups re-run CI only"): a coordinator may answer `merge` on
 * a land approve-merge gate when the owner answered `merge` on an earlier land gate of the same run, and every commit from
 * that approved head to the gated head is a clean merge-up of the base. Publish, device and visual gates are other steps,
 * and every other answer stays the owner's.
 */
export const MERGE_UP_APPROVAL = Object.freeze({
  /** The classes whose `merge` answer is the approval the merge-ups follow from. */
  approvedBy: OWNER_CLASSES,
  /** A longer chain asks the owner again rather than walking an unbounded history. */
  maxMergeUps: 20,
});

const SHA = z.string().regex(/^[0-9a-f]{40}$/);

/** One verified merge-up: its tree is the clean merge-tree of its parents, and the second parent is on the base branch. */
export const MergeUpCommit = z.strictObject({
  sha: SHA,
  firstParent: SHA,
  secondParent: SHA,
  secondParentOnBase: z.literal(true),
  tree: SHA,
  mergeTree: SHA,
});
export type MergeUpCommit = z.infer<typeof MergeUpCommit>;

/**
 * The commits from `fromHead` to `head`, oldest first, form one first-parent line of merge-ups that each change nothing
 * the base did not bring. An empty chain is no merge-up, and a longer one than the rule allows is not read as one.
 */
export function isMergeUpChain(commits: readonly MergeUpCommit[], fromHead: string, head: string): boolean {
  if (commits.length === 0 || commits.length > MERGE_UP_APPROVAL.maxMergeUps || commits.at(-1)?.sha !== head) return false;
  return commits.every((commit, index) => commit.firstParent === (index === 0 ? fromHead : commits[index - 1]!.sha) && commit.tree === commit.mergeTree);
}
