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
  /** Check-run app ids the caller trusts; the package pins none. */
  allowedApps: number[];
  checkRuns: CheckRunFact[];
  mergeTreeClean: boolean;
  repoFrozen: boolean;
  /** Every path the pull request touches, including both sides of a rename. */
  changedPaths: string[];
  seatGrants: string[];
}

export interface ConditionFacts {
  merge?: MergeFacts;
}

const GREEN_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const FULL_SHA = /^[0-9a-f]{40}$/;
const PROTECTED_DIRS = new Set([".github"]);
const PROTECTED_FILES = new Set(["codeowners", "docs/codeowners", ".gitmodules"]);
const NON_CANONICAL_SEGMENTS = new Set(["", ".", ".."]);

function sameAgent(a: AgentIdentity, b: AgentIdentity): boolean {
  return a.agentId !== "" && a.sessionId !== "" && a.agentId === b.agentId && a.sessionId === b.sessionId;
}

function verdictMergeAtHead(facts: MergeFacts): boolean {
  return facts.verdict.value === "MERGE" && FULL_SHA.test(facts.head) && facts.verdict.head === facts.head;
}

// A path we cannot compare exactly could alias a protected one, so it counts as protected.
function isNonCanonical(path: string): boolean {
  return path.includes("\\") || path.split("/").some((segment) => NON_CANONICAL_SEGMENTS.has(segment));
}

function isProtectedPath(path: string): boolean {
  const folded = path.toLowerCase();
  return isNonCanonical(path) || PROTECTED_FILES.has(folded) || PROTECTED_DIRS.has(folded.split("/")[0]!);
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
  "verdict-merge-at-head": verdictMergeAtHead,
  "required-contexts-green": requiredContextsGreen,
  "no-non-green-run": noNonGreenRun,
  "merge-tree-clean": (facts) => facts.mergeTreeClean,
  "repo-not-frozen": (facts) => !facts.repoFrozen,
  "no-protected-path-change": (facts) => !facts.changedPaths.some(isProtectedPath),
  "seat-grants-merge-on-green-approve": (facts) => facts.seatGrants.includes("merge-on-green-approve"),
};

// Facts arrive from outside the type system, so a malformed fact fails its condition instead of throwing.
function holds(check: (facts: MergeFacts) => boolean, facts: MergeFacts): boolean {
  try {
    return check(facts);
  } catch {
    return false;
  }
}

/** The conditions that do not hold. Missing facts fail every condition, so a caller that observed nothing gets nothing. */
export function unmetConditions(conditions: readonly ConditionKind[], facts: ConditionFacts | undefined): ConditionKind[] {
  const merge = facts?.merge;
  if (!merge) return [...conditions];
  return conditions.filter((condition) => !holds(MERGE_CHECKS[condition], merge));
}
