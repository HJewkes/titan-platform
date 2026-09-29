import type { ConditionKind } from "./vocabulary.js";

export interface AgentIdentity {
  agentId: string;
  sessionId: string;
}

export interface CheckRunFact {
  name: string;
  appId: number;
  headSha: string;
  /** GitHub's conclusion; `null` while the run is queued or in progress. */
  conclusion: string | null;
}

/** What the caller observed about a pull request it wants to merge. The evaluator re-derives every condition from these. */
export interface MergeFacts {
  head: string;
  resolver: AgentIdentity;
  dispatchedReviewer: AgentIdentity;
  verdict: { value: string; head: string };
  requiredContexts: string[];
  allowedApps: number[];
  checkRuns: CheckRunFact[];
  mergeTreeClean: boolean;
  repoFrozen: boolean;
  changedPaths: string[];
  seatGrants: string[];
}

export interface ConditionFacts {
  merge?: MergeFacts;
}

const GREEN_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const WORKFLOW_PREFIXES = [".github/workflows/", ".github/actions/"];

function sameAgent(a: AgentIdentity, b: AgentIdentity): boolean {
  return a.agentId !== "" && a.sessionId !== "" && a.agentId === b.agentId && a.sessionId === b.sessionId;
}

function countedRuns(facts: MergeFacts): CheckRunFact[] {
  return facts.checkRuns.filter((run) => run.headSha === facts.head && facts.allowedApps.includes(run.appId));
}

function requiredContextsGreen(facts: MergeFacts): boolean {
  const runs = countedRuns(facts);
  return facts.requiredContexts.length > 0 &&
    facts.requiredContexts.every((context) => runs.some((run) => run.name === context && run.conclusion === "success"));
}

function noNonGreenRun(facts: MergeFacts): boolean {
  return countedRuns(facts).every((run) => run.conclusion !== null && GREEN_CONCLUSIONS.has(run.conclusion));
}

const MERGE_CHECKS: Record<ConditionKind, (facts: MergeFacts) => boolean> = {
  "resolver-is-dispatched-reviewer": (facts) => sameAgent(facts.resolver, facts.dispatchedReviewer),
  "verdict-merge-at-head": (facts) => facts.verdict.value === "MERGE" && facts.head !== "" && facts.verdict.head === facts.head,
  "required-contexts-green": requiredContextsGreen,
  "no-non-green-run": noNonGreenRun,
  "merge-tree-clean": (facts) => facts.mergeTreeClean,
  "repo-not-frozen": (facts) => !facts.repoFrozen,
  "no-workflow-change": (facts) => !facts.changedPaths.some((path) => WORKFLOW_PREFIXES.some((prefix) => path.startsWith(prefix))),
  "seat-grants-merge-on-green-approve": (facts) => facts.seatGrants.includes("merge-on-green-approve"),
};

/** The conditions that do not hold. Missing facts fail every condition, so a caller that observed nothing gets nothing. */
export function unmetConditions(conditions: readonly ConditionKind[], facts: ConditionFacts | undefined): ConditionKind[] {
  const merge = facts?.merge;
  if (!merge) return [...conditions];
  return conditions.filter((condition) => !MERGE_CHECKS[condition](merge));
}
