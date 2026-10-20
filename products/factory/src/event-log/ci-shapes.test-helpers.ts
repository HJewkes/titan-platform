import type { BackstopContext } from "./ci-keys.js";

/** A concluded CI fact; the two builders below render it in each source's wire shape. */
export interface CiFact {
  type: "check" | "status";
  repo: string;
  head: string;
  context: string;
  checkRunId?: number;
  outcome: string;
  /** UTC seconds. */
  at: string;
}

/** Shaped after the `check_run` completed example in GitHub's webhook events documentation. */
export function checkRunDelivery(fact: CiFact): Record<string, unknown> {
  return {
    action: "completed",
    check_run: { id: fact.checkRunId, name: fact.context, head_sha: fact.head, status: "completed", conclusion: fact.outcome, completed_at: fact.at },
    repository: { full_name: fact.repo },
  };
}

/** Shaped after the `status` example in GitHub's webhook events documentation. */
export function statusDelivery(fact: CiFact): unknown {
  return { sha: fact.head, context: fact.context, state: fact.outcome, created_at: fact.at, repository: { full_name: fact.repo } };
}

/** Shaped after a StatusCheckRollup context node: upper-case enums, as the GraphQL schema documents them. */
export function backstopNode(fact: CiFact): BackstopContext {
  const outcome = fact.outcome.toUpperCase();
  if (fact.type === "check") {
    return { __typename: "CheckRun", databaseId: fact.checkRunId ?? 0, name: fact.context, status: "COMPLETED", conclusion: outcome, completedAt: fact.at };
  }
  return { __typename: "StatusContext", context: fact.context, state: outcome, createdAt: fact.at };
}
