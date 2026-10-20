import type { BackstopDonePr, BackstopOpenPr } from "./repo-keys.js";

/** One PR as it stands; the builders below render it in each source's wire shape. */
export interface PrFact {
  repo: string;
  pr: number;
  head: string;
  base: string;
  reviews?: { id: number; state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING" }[];
  end?: { merged: boolean; mergeSha: string | null; closedAt: string; mergedBy?: string };
}

/** Shaped after the `pull_request` examples in GitHub's webhook events documentation. */
export function pullRequestDelivery(fact: PrFact, action = fact.end === undefined ? "synchronize" : "closed"): Record<string, unknown> {
  const pullRequest = {
    number: fact.pr,
    head: { sha: fact.head },
    base: { ref: fact.base },
    merged: fact.end?.merged ?? false,
    merge_commit_sha: fact.end?.mergeSha ?? null,
    closed_at: fact.end?.closedAt ?? null,
    merged_by: fact.end?.mergedBy === undefined ? null : { login: fact.end.mergedBy },
  };
  return { action, number: fact.pr, pull_request: pullRequest, repository: { full_name: fact.repo } };
}

/** Shaped after the `pull_request_review` submitted and dismissed examples in GitHub's webhook events documentation. */
export function reviewDelivery(fact: PrFact, id: number, action: string): unknown {
  return { action, review: { id, state: action === "dismissed" ? "dismissed" : "approved" }, pull_request: { number: fact.pr }, repository: { full_name: fact.repo } };
}

/** Shaped after the `repository_ruleset` example in GitHub's webhook events documentation. */
export function rulesetDelivery(repo: string, id: number, updatedAt: string, action = "edited"): unknown {
  return { action, repository_ruleset: { id, updated_at: updatedAt }, repository: { full_name: repo } };
}

/** Shaped after the `push` example in GitHub's webhook events documentation. */
export function pushDelivery(repo: string, branch: string, sha: string, defaultBranch = "main"): unknown {
  return { ref: `refs/heads/${branch}`, after: sha, deleted: false, repository: { full_name: repo, default_branch: defaultBranch } };
}

/** Shaped after the backstop's open-PR node (packages/github backstop-query `GhOpenPr`). */
export function backstopOpenPr(fact: PrFact): BackstopOpenPr {
  return { number: fact.pr, headRefOid: fact.head, baseRefName: fact.base, reviews: { nodes: (fact.reviews ?? []).map((r) => ({ databaseId: r.id, state: r.state })) } };
}

/** Shaped after the backstop's merged-or-closed node (`GhDonePr`), whose stamps carry a fraction GitHub's REST omits. */
export function backstopDonePr(fact: PrFact): BackstopDonePr {
  const end = fact.end ?? { merged: false, mergeSha: null, closedAt: "" };
  return {
    number: fact.pr,
    merged: end.merged,
    mergedBy: end.mergedBy === undefined ? null : { login: end.mergedBy },
    mergeCommit: end.mergeSha === null ? null : { oid: end.mergeSha },
    closedAt: end.closedAt === "" ? null : end.closedAt.replace("Z", ".000Z"),
  };
}
