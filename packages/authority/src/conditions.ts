import type { ConditionKind, MergeConditionKind, QuestionConditionKind } from "./vocabulary.js";

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

/** The tree-equality probe's answer for a head that updates a reviewed head; the caller reads it from its probe step, never from reviewer text. */
export interface CarryFact {
  /** The head whose MERGE verdict is carried. */
  fromHead: string;
  /** The head the carry is for. */
  head: string;
  headTree: string;
  /** For a remerge rule, the tree git's own remerge of the head's two parents writes, conflict markers and all. */
  mergeTree: string;
  /** Which probe carried the verdict; absent reads as `tree-equal`. */
  rule?: "tree-equal" | "remerge-empty" | "remerge-generated-only";
  /** For a remerge rule: every path the head's remerge-diff or the remerge's conflicts touch. */
  remergePaths?: string[];
  /** For a remerge rule: the paths among `remergePaths` that the repo declares generated. */
  generatedPaths?: string[];
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
  /** Per-context override of `allowedApps`: a run of a listed context counts only from these apps. Absent means `allowedApps` for every context. */
  contextApps?: Record<string, number[]>;
  checkRuns: CheckRunFact[];
  mergeTreeClean: boolean;
  repoFrozen: boolean;
  /** Every path the pull request touches, including both sides of a rename. */
  changedPaths: string[];
  seatGrants: string[];
  carry?: CarryFact;
  /** The kind the pull request was registered with; absent when unregistered. */
  kind?: string;
}

/** What the caller observed about the question gate a decider wants to answer. */
export interface QuestionFacts {
  /** The kind of rule the gate was opened under; only `question` passes. */
  ruleKind: string;
  /** The decision mode of the question's category; only `auto` passes. */
  mode: string;
}

export interface ConditionFacts {
  merge?: MergeFacts;
  question?: QuestionFacts;
}

const GREEN_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const CARRYING_KINDS = new Set(["correctness", "feature", "refactor"]);
const FULL_SHA = /^[0-9a-f]{40}$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const PROTECTED_FILES = new Set(["codeowners", "docs/codeowners", ".github/codeowners", ".gitmodules"]);
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

function verdictMergeCarriedTreeEqual(facts: MergeFacts): boolean {
  const { head, carry, verdict } = facts;
  if (verdict.value !== "MERGE" || typeof head !== "string" || !FULL_SHA.test(head) || !isRecord(carry)) return false;
  return typeof carry.fromHead === "string" && FULL_SHA.test(carry.fromHead) && verdict.head === carry.fromHead && carry.head === head &&
    isId(carry.headTree) && carry.headTree === carry.mergeTree;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// Each touched path must be one the collector matched to the repo's declared generated files, and never a protected one.
function remergeTouchesOnlyGenerated(carry: CarryFact): boolean {
  const { remergePaths, generatedPaths } = carry;
  if (!isStringList(remergePaths) || !isStringList(generatedPaths)) return false;
  if (carry.rule === "remerge-empty") return remergePaths.length === 0 && carry.headTree === carry.mergeTree;
  if (carry.rule !== "remerge-generated-only" || remergePaths.length === 0) return false;
  return remergePaths.every((path) => generatedPaths.includes(path) && !isProtectedPath(path));
}

function verdictMergeCarriedRemergeClean(facts: MergeFacts): boolean {
  const { head, carry, verdict } = facts;
  if (verdict.value !== "MERGE" || typeof head !== "string" || !FULL_SHA.test(head) || !isRecord(carry)) return false;
  return typeof carry.fromHead === "string" && FULL_SHA.test(carry.fromHead) && verdict.head === carry.fromHead && carry.head === head &&
    isId(carry.headTree) && isId(carry.mergeTree) && remergeTouchesOnlyGenerated(carry);
}

// Only a known non-security kind passes, so an unregistered or unrecognised kind never carries.
function prKindNotSecurity(facts: MergeFacts): boolean {
  return typeof facts.kind === "string" && CARRYING_KINDS.has(facts.kind);
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
  return PROTECTED_FILES.has(folded);
}

function isWellFormedRun(run: CheckRunFact): boolean {
  return isId(run.name) && Number.isInteger(run.appId) && isId(run.headSha) &&
    (run.conclusion === null || typeof run.conclusion === "string");
}

function isAppList(apps: unknown): boolean {
  return Array.isArray(apps) && apps.every((app) => Number.isInteger(app));
}

function hasContextApps(facts: MergeFacts): boolean {
  const { contextApps } = facts;
  return contextApps === undefined || (isRecord(contextApps) && Object.values(contextApps).every(isAppList));
}

function hasRunFacts(facts: MergeFacts): boolean {
  return Array.isArray(facts.checkRuns) && isAppList(facts.allowedApps) && hasContextApps(facts);
}

// An own key only, so a context named like an Object.prototype member never picks up an inherited list.
function appsFor(facts: MergeFacts, context: string): number[] {
  const { contextApps } = facts;
  return contextApps !== undefined && Object.hasOwn(contextApps, context) ? contextApps[context]! : facts.allowedApps;
}

function countedRuns(facts: MergeFacts): CheckRunFact[] {
  return facts.checkRuns.filter((run) => isWellFormedRun(run) && run.headSha === facts.head && appsFor(facts, run.name).includes(run.appId));
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

const MERGE_CHECKS: Record<MergeConditionKind, (facts: MergeFacts) => boolean> = {
  "resolver-is-dispatched-reviewer": (facts) => sameAgent(facts.resolver, facts.dispatchedReviewer),
  "verdict-merge-at-head": verdictMergeAtHead,
  "verdict-merge-carried-tree-equal": verdictMergeCarriedTreeEqual,
  "verdict-merge-carried-remerge-clean": verdictMergeCarriedRemergeClean,
  "pr-kind-not-security": prKindNotSecurity,
  "required-contexts-green": requiredContextsGreen,
  "no-non-green-run": noNonGreenRun,
  "merge-tree-clean": (facts) => facts.mergeTreeClean === true,
  "repo-not-frozen": (facts) => facts.repoFrozen === false,
  "no-protected-path-change": noProtectedPathChange,
  "seat-grants-merge-on-green-approve": (facts) => Array.isArray(facts.seatGrants) && facts.seatGrants.includes("merge-on-green-approve"),
};

// Exact strings only, so an unknown, missing or differently cased kind or mode fails closed.
const QUESTION_CHECKS: Record<QuestionConditionKind, (facts: QuestionFacts) => boolean> = {
  "gate-rule-is-question": (facts) => facts.ruleKind === "question",
  "category-mode-auto": (facts) => facts.mode === "auto",
};

// Facts arrive from outside the type system, so a malformed fact fails its condition instead of throwing.
function holds<T>(check: ((facts: T) => boolean) | undefined, facts: unknown): boolean {
  if (check === undefined || !isRecord(facts)) return false;
  try {
    return check(facts as T);
  } catch {
    return false;
  }
}

function conditionHolds(condition: ConditionKind, facts: ConditionFacts): boolean {
  if (Object.hasOwn(MERGE_CHECKS, condition)) return holds(MERGE_CHECKS[condition as MergeConditionKind], facts.merge);
  if (Object.hasOwn(QUESTION_CHECKS, condition)) return holds(QUESTION_CHECKS[condition as QuestionConditionKind], facts.question);
  return false;
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
 * The facts as fresh plain data, read once, or undefined when they are not plain data.
 * structuredClone rejects functions (so no toJSON can speak for a value), Proxies and throwing getters;
 * the rebuild then reads own properties only and rejects Map, Set, Date, BigInt, cycles and sparse arrays.
 */
export function plainFacts(read: () => unknown): ConditionFacts | undefined {
  try {
    const copy = toPlainData(structuredClone(read()), new Set());
    return isRecord(copy) ? (copy as ConditionFacts) : undefined;
  } catch {
    return undefined;
  }
}

/** The conditions that do not hold on facts already made plain by `plainFacts`. */
export function unmetPlainConditions(conditions: readonly ConditionKind[], facts: ConditionFacts | undefined): ConditionKind[] {
  if (!facts) return [...conditions];
  return conditions.filter((condition) => !conditionHolds(condition, facts));
}

/** The conditions that do not hold. Missing or non-plain facts fail every condition, so a caller that observed nothing gets nothing. */
export function unmetConditions(conditions: readonly ConditionKind[], facts: ConditionFacts | undefined): ConditionKind[] {
  return unmetPlainConditions(conditions, plainFacts(() => facts));
}
