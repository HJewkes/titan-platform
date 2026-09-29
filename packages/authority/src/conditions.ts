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
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const PROTECTED_DIRS = new Set([".github"]);
const PROTECTED_FILES = new Set(["codeowners", "docs/codeowners", ".gitmodules"]);
const NON_CANONICAL_SEGMENTS = new Set(["", ".", ".."]);
const TRAILING_SPACE_OR_DOT = /[ .]$/;

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function sameAgent(a: AgentIdentity, b: AgentIdentity): boolean {
  return isId(a.agentId) && isId(a.sessionId) && a.agentId === b.agentId && a.sessionId === b.sessionId;
}

function verdictMergeAtHead(facts: MergeFacts): boolean {
  const { head } = facts;
  return facts.verdict.value === "MERGE" && typeof head === "string" && FULL_SHA.test(head) && facts.verdict.head === head;
}

function isNonCanonicalSegment(segment: string): boolean {
  return NON_CANONICAL_SEGMENTS.has(segment) || TRAILING_SPACE_OR_DOT.test(segment);
}

// A path we cannot compare exactly could alias a protected one, so it counts as protected.
function isNonCanonical(path: string): boolean {
  return !PRINTABLE_ASCII.test(path) || path.includes("\\") || path.split("/").some(isNonCanonicalSegment);
}

function isProtectedPath(path: unknown): boolean {
  if (typeof path !== "string" || isNonCanonical(path)) return true;
  const folded = path.toLowerCase();
  return PROTECTED_FILES.has(folded) || PROTECTED_DIRS.has(folded.split("/")[0]!);
}

function isWellFormedRun(run: CheckRunFact): boolean {
  return isId(run.name) && Number.isInteger(run.appId) && isId(run.headSha) &&
    (run.conclusion === null || typeof run.conclusion === "string");
}

function hasRunFacts(facts: MergeFacts): boolean {
  return Array.isArray(facts.checkRuns) && Array.isArray(facts.allowedApps) &&
    facts.allowedApps.every((app) => Number.isInteger(app));
}

function countedRuns(facts: MergeFacts): CheckRunFact[] {
  return facts.checkRuns.filter((run) => isWellFormedRun(run) && run.headSha === facts.head && facts.allowedApps.includes(run.appId));
}

function requiredContextsGreen(facts: MergeFacts): boolean {
  const contexts = facts.requiredContexts;
  if (!hasRunFacts(facts) || !Array.isArray(contexts) || contexts.length === 0) return false;
  const runs = countedRuns(facts);
  return contexts.every((context) => isId(context) && runs.some((run) => run.name === context && run.conclusion === "success"));
}

// A run we cannot attribute to a head or an app might be a failure at this head, so it gates.
function noNonGreenRun(facts: MergeFacts): boolean {
  return hasRunFacts(facts) && facts.checkRuns.every(isWellFormedRun) &&
    countedRuns(facts).every((run) => run.conclusion !== null && GREEN_CONCLUSIONS.has(run.conclusion));
}

function noProtectedPathChange(facts: MergeFacts): boolean {
  const paths = facts.changedPaths;
  return Array.isArray(paths) && paths.length > 0 && !paths.some(isProtectedPath);
}

const MERGE_CHECKS: Record<ConditionKind, (facts: MergeFacts) => boolean> = {
  "resolver-is-dispatched-reviewer": (facts) => sameAgent(facts.resolver, facts.dispatchedReviewer),
  "verdict-merge-at-head": verdictMergeAtHead,
  "required-contexts-green": requiredContextsGreen,
  "no-non-green-run": noNonGreenRun,
  "merge-tree-clean": (facts) => facts.mergeTreeClean === true,
  "repo-not-frozen": (facts) => facts.repoFrozen === false,
  "no-protected-path-change": noProtectedPathChange,
  "seat-grants-merge-on-green-approve": (facts) => Array.isArray(facts.seatGrants) && facts.seatGrants.includes("merge-on-green-approve"),
};

// Facts arrive from outside the type system, so a malformed fact fails its condition instead of throwing.
function holds(check: (facts: MergeFacts) => boolean, facts: MergeFacts): boolean {
  try {
    return check(facts);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Checks read only a JSON copy: getters, prototypes and holes are gone, and anything that cannot be copied yields no facts.
function plainMergeFacts(read: () => ConditionFacts | undefined): MergeFacts | undefined {
  try {
    const copy: unknown = JSON.parse(JSON.stringify(read() ?? null));
    const merge = isRecord(copy) ? copy.merge : undefined;
    return isRecord(merge) ? (merge as unknown as MergeFacts) : undefined;
  } catch {
    return undefined;
  }
}

/** Like `unmetConditions`, but reads the facts inside the guard so a throwing accessor fails every condition. */
export function unmetConditionsOf(conditions: readonly ConditionKind[], read: () => ConditionFacts | undefined): ConditionKind[] {
  const merge = plainMergeFacts(read);
  if (!merge) return [...conditions];
  return conditions.filter((condition) => !holds(MERGE_CHECKS[condition], merge));
}

/** The conditions that do not hold. Missing or unreadable facts fail every condition, so a caller that observed nothing gets nothing. */
export function unmetConditions(conditions: readonly ConditionKind[], facts: ConditionFacts | undefined): ConditionKind[] {
  return unmetConditionsOf(conditions, () => facts);
}
