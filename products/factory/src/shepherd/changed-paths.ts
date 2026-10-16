import { CarryRefusal, type Git } from "./tree-carry.js";

/**
 * The paths that differ between two commits or trees, in git's order. A rename is listed as its delete and its add, so both
 * the old and the new path meet the carry fence: plumbing diff-tree ignores `diff.renames`, and `--no-renames` pins it anyway.
 * Stdout is not trimmed, since a path may begin or end with whitespace. A git error throws rather than reading as no change.
 */
export async function changedPathsBetween(git: Git, dir: string, from: string, to: string, signal?: AbortSignal): Promise<string[]> {
  const result = await git(dir, ["diff-tree", "-r", "--no-renames", "--name-only", "-z", from, to], signal);
  if (result.code !== 0) throw new CarryRefusal("diff-tree", result.code);
  return result.stdout.split("\0").filter((path) => path !== "");
}
