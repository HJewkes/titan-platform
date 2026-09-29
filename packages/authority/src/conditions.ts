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

const LEAF_TYPES = new Set(["string", "number", "boolean", "undefined"]);

// A hole would read through to a possibly polluted prototype, and no fact list has a use for one.
function rebuildArray(value: unknown[], ancestors: Set<object>): unknown[] {
  const copy: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError("fact lists must not be sparse");
    const item = toPlainData(value[index], ancestors);
    Object.defineProperty(copy, index, { value: item, writable: true, enumerable: true, configurable: true });
  }
  return copy;
}

// Copies onto null-prototype objects, so a polluted Object.prototype cannot supply a missing fact.
function rebuildRecord(value: object, ancestors: Set<object>): Record<string, unknown> {
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("facts must be plain objects");
  const copy: Record<string, unknown> = Object.create(null);
  for (const [key, field] of Object.entries(value)) copy[key] = toPlainData(field, ancestors);
  return copy;
}

function toPlainData(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || LEAF_TYPES.has(typeof value)) return value;
  if (typeof value !== "object" || ancestors.has(value)) throw new TypeError("facts must be acyclic JSON-shaped data");
  ancestors.add(value);
  const copy = Array.isArray(value) ? rebuildArray(value, ancestors) : rebuildRecord(value, ancestors);
  ancestors.delete(value);
  return copy;
}

/**
 * The merge facts as fresh plain data, read once, or undefined when they are not plain data.
 * structuredClone rejects functions (so no toJSON can speak for a value), Proxies and throwing getters;
 * the rebuild then reads own properties only and rejects Map, Set, Date, BigInt, cycles and sparse arrays.
 */
export function plainMergeFacts(read: () => unknown): MergeFacts | undefined {
  try {
    const copy = toPlainData(structuredClone(read()), new Set());
    const merge = isRecord(copy) ? copy.merge : undefined;
    return isRecord(merge) ? (merge as unknown as MergeFacts) : undefined;
  } catch {
    return undefined;
  }
}

/** The conditions that do not hold on facts already made plain by `plainMergeFacts`. */
export function unmetMergeConditions(conditions: readonly ConditionKind[], merge: MergeFacts | undefined): ConditionKind[] {
  if (!merge) return [...conditions];
  return conditions.filter((condition) => !holds(MERGE_CHECKS[condition], merge));
}

/** The conditions that do not hold. Missing or non-plain facts fail every condition, so a caller that observed nothing gets nothing. */
export function unmetConditions(conditions: readonly ConditionKind[], facts: ConditionFacts | undefined): ConditionKind[] {
  return unmetMergeConditions(conditions, plainMergeFacts(() => facts));
}
