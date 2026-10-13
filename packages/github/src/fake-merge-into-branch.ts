import type { FakeGitHub } from "./fake-types.js";
import type { MergeIntoBranchRequest, MergeIntoBranchResult } from "./merge-into-branch.js";

/** Like GitHub's Merges API: a missing branch answers 404, a head the tip reaches is contained, and a listed head conflicts. */
export function fakeMergeIntoBranch(fake: FakeGitHub, request: MergeIntoBranchRequest, nextSha: (tag: string) => string, notFound: (message: string) => Error): MergeIntoBranchResult {
  const tip = fake.refs.get(request.branch);
  if (tip === undefined) throw notFound(`Base ${request.branch} does not exist`);
  const result = outcomeOf(fake, tip, request, nextSha);
  fake.branchMerges.push({ branch: request.branch, head: request.head, outcome: result.outcome });
  return result;
}

function outcomeOf(fake: FakeGitHub, tip: string, request: MergeIntoBranchRequest, nextSha: (tag: string) => string): MergeIntoBranchResult {
  if (reaches(fake, tip, request.head)) return { outcome: "already-contained" };
  if (fake.mergeConflicts.has(request.head)) return { outcome: "conflict" };
  const sha = nextSha("branch-merge");
  fake.commits.set(sha, { sha, parents: [tip, request.head] });
  fake.refs.set(request.branch, sha);
  return { outcome: "merged", sha };
}

/** Walks the parents the fake recorded; a commit it never recorded has none. */
function reaches(fake: FakeGitHub, from: string, target: string): boolean {
  const seen = new Set<string>();
  for (const queue = [from]; queue.length > 0; ) {
    const sha = queue.pop()!;
    if (sha === target) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    queue.push(...(fake.commits.get(sha)?.parents ?? []));
  }
  return false;
}
