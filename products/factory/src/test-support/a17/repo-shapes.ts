/** A repository fact other than CI; the builders below render it as GitHub's delivery for that event. */
export type RepoFact =
  | { type: "pr"; repo: string; pr: number; head: string; base: string; action: "opened" | "synchronize" | "edited" }
  | { type: "review"; repo: string; pr: number; id: number; action: "submitted" | "dismissed" }
  | { type: "ended"; repo: string; pr: number; merged: boolean; mergeSha: string | null; mergedBy?: string; closedAt: string }
  | { type: "push"; repo: string; sha: string }
  | { type: "ruleset"; repo: string; id: number; updatedAt: string };

interface Delivery {
  event: string;
  body: unknown;
}

/** The PR as GitHub's `pull_request` delivery carries it; `ended` supplies how it closed. */
function pullRequest(fact: Extract<RepoFact, { type: "pr" | "ended" }>, head: string, base: string): Record<string, unknown> {
  const ended = fact.type === "ended" ? fact : undefined;
  return {
    number: fact.pr,
    head: { sha: head },
    base: { ref: base },
    merged: ended?.merged ?? false,
    merge_commit_sha: ended?.mergeSha ?? null,
    closed_at: ended?.closedAt ?? null,
    merged_by: ended?.mergedBy === undefined ? null : { login: ended.mergedBy },
  };
}

/**
 * Shaped after the `pull_request`, `pull_request_review`, `push` and `repository_ruleset` examples in GitHub's webhook
 * events documentation. `pr` is the PR as it stood, which a `closed` delivery repeats.
 */
export function repoDelivery(fact: RepoFact, pr: { head: string; base: string } | undefined): Delivery {
  const repository = { full_name: fact.repo };
  switch (fact.type) {
    case "pr": {
      const changes = fact.action === "edited" ? { changes: { base: { ref: { from: pr?.base ?? fact.base } } } } : {};
      return { event: "pull_request", body: { action: fact.action, number: fact.pr, pull_request: pullRequest(fact, fact.head, fact.base), repository, ...changes } };
    }
    case "ended":
      if (pr === undefined) throw new Error(`${fact.repo}#${fact.pr} is not open`);
      return { event: "pull_request", body: { action: "closed", number: fact.pr, pull_request: pullRequest(fact, pr.head, pr.base), repository } };
    case "review":
      return { event: "pull_request_review", body: { action: fact.action, review: { id: fact.id, state: fact.action === "dismissed" ? "dismissed" : "approved" }, pull_request: { number: fact.pr }, repository } };
    case "push":
      return { event: "push", body: { ref: "refs/heads/main", after: fact.sha, deleted: false, repository: { ...repository, default_branch: "main" } } };
    case "ruleset":
      return { event: "repository_ruleset", body: { action: "edited", repository_ruleset: { id: fact.id, updated_at: fact.updatedAt }, repository } };
  }
}

/** The kinds a fact's rows carry, so a fact's steps leave out the re-observations of everything else on the repo. */
export const FACT_KINDS: Record<RepoFact["type"] | "ci", readonly string[]> = {
  ci: ["CIConcluded"],
  pr: ["HeadPushed", "BaseChanged"],
  review: ["ReviewSubmitted", "ReviewDismissed"],
  ended: ["PRMerged", "PRClosed"],
  push: ["MainMoved"],
  ruleset: ["RulesChanged"],
};
