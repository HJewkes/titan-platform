import { execFile } from "node:child_process";
import type { CleanMergeTree } from "./approved-head-walk.js";

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * `git merge-tree --write-tree` in a local clone that already has both commits. Only the titan-gh bin
 * wires this in, for `premerge --clone`; the package's cores never run git.
 */
export function gitMergeTree(clone: string): CleanMergeTree {
  return (baseParent, reviewed) =>
    new Promise((resolve, reject) => {
      execFile("git", ["-C", clone, "merge-tree", "--write-tree", baseParent, reviewed], (error, stdout, stderr) => {
        const tree = stdout.split("\n")[0]!.trim();
        if (!error && OID.test(tree)) return resolve(tree);
        // Exit 1 also means an unknown commit; only a conflict still writes the conflicted tree's oid first.
        if (error?.code === 1 && OID.test(tree)) return resolve(null);
        reject(new Error(`git merge-tree exited ${String(error?.code ?? 0)}: ${stderr.trim() || stdout.trim()}`));
      });
    });
}
