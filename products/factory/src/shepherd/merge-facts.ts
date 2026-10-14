import { compileGlobs } from "@titan-design/fix-proof";
import { DEFAULT_TABLE, evaluate, type AgentIdentity, type CarryFact, type CheckRunFact, type MergeFacts } from "@titan-design/authority";
import { GITHUB_ACTIONS_APP_ID, type CheckRun, type GitHubPort, type PullRequest, type RepoSlug } from "@titan-design/github";
import type { CiPolicy, SourceTextLocator } from "@titan-design/session-read";
import { oneLine } from "../gate-brief.js";
import { readRequiredChecks, statusOf } from "../required-checks.js";
import type { GateDecision, PolicyRule } from "../gate-policy.js";
import { errorClass } from "./error-class.js";
import { grantWithheldField, withGrantWithheld, type GrantWithheldField } from "./grant-withheld.js";
import { CI_POLICY_MALFORMED_REASON, CI_POLICY_WEAKENED_PREFIX, GITHUB_PATH_REASON_PREFIX, SKILL_REASON_PREFIX, VISUAL_REASON_PREFIX, evidenceComment, evidenceMarker } from "./evidence-comment.js";
import { pinnedPaths } from "./pr-changed-paths.js";
import { REVIEW_CHECK_NAME } from "./publish-review.js";
import type { ShepherdStoreRef } from "./store.js";
import { skillPathsIn } from "./skill-paths.js";
import { remergeFact, type CarryRule, type RemergeResult } from "./remerge-carry.js";
import type { CarryResult } from "./tree-carry.js";

export const MERGE_EVIDENCE_STEP = "sh-merge-evidence";

/** The rules that let Shepherd merge without the owner; any other allow still gates. */
export const MERGE_BY_REVIEWER_RULE = "MRG-AU-RV";
export const MERGE_BY_CARRIED_VERDICT_RULE = "MRG-AU-RC";
const MERGE_BY_REMERGED_VERDICT_RULE = "MRG-AU-RM";
const AUTO_MERGE_RULES: readonly string[] = [MERGE_BY_REVIEWER_RULE, MERGE_BY_CARRIED_VERDICT_RULE, MERGE_BY_REMERGED_VERDICT_RULE];

/** Authority pins no app, so Shepherd trusts check runs from GitHub Actions only. */
export const ALLOWED_CHECK_APPS: readonly number[] = [GITHUB_ACTIONS_APP_ID];

/** The check only the Shepherd App may satisfy; no App configured leaves it with no counting app, so a required one gates. */
function reviewContextApps(reviewAppId: number | undefined): Record<string, number[]> {
  return { [REVIEW_CHECK_NAME]: reviewAppId === undefined ? [] : [reviewAppId] };
}

const AUTHORITY_ACTOR = { class: "automation", id: "titan-factory" } as const;
const AUTHORITY_VERSION = Number.parseInt(DEFAULT_TABLE.version, 10);
const MERGEABLE = new Set(["clean", "unstable", "has_hooks"]);

/** GitHub computes mergeability lazily, so a fresh PR reads `unknown` for a few seconds. */
const SETTLE_MAX_READS = 3;
const SETTLE_INTERVAL_MS = 5_000;

interface SettleClock {
  sleep: (ms: number) => Promise<void>;
}

const REAL_CLOCK: SettleClock = { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

/** Whether `repo` is frozen for `pr`: a freeze's own fix PR reads not frozen, as the freeze guard lets it land. */
export type IsFrozen = (repo: RepoSlug, pr: number) => Promise<boolean>;

/** A stand-in until TP-523 adds the freeze store: no repo can be frozen before it exists. */
export const noFreezeStoreUntilTp523: IsFrozen = async () => false;

export interface MergeEvidenceInput extends GrantWithheldField {
  runId: string;
  repo: RepoSlug;
  pr: number;
  head: string;
  verdict: { value: "MERGE"; head: string; locator: SourceTextLocator };
  /** The author of the accepted verdict, read from the sh-await-verdict output. */
  resolver: AgentIdentity;
  /** The reviewer this run dispatched, read from the dispatch record, so a mismatch with the resolver gates. */
  dispatchedReviewer: AgentIdentity;
  seatGrants: string[];
  /** The `sh-carry` step's answer for this head, with the head it asked about; absent means no carry was probed. `remerge` is the `sh-remerge` answer behind a remerge rule. */
  carry?: { fromHead: string; head: string; result: CarryResult; rule?: CarryRule; remerge?: RemergeResult };
  /** The run policy's visual globs, so the evidence comment records the same decision `decide` reaches. */
  visualPaths?: string[];
  /** The seat's baseline check and files, so a visual head that changes no baseline can clear on that check. */
  visualBaselines?: VisualBaselines;
  /** The reviewer's CI-policy line on the MERGE; absent gates a `.github/` change. */
  ciPolicy?: CiPolicy;
  /** The head's unverified fix-proof standing and read reason; recorded, never gated on (decision 303). */
  proofUnverified?: string;
}

/** A check that diffs rendered output against committed baselines: a rendered change must change a file under `paths`. */
export interface VisualBaselines {
  check: string;
  paths: string[];
}

export interface EvidenceCheckRun {
  name: string;
  id: number;
  appId: number | null;
  conclusion: string | null;
}

/** What `allowEvidence` stores in `merge-policy`, whole. The PR comment carries the same record with `verdictLocator` reduced to a `LocatorReference`. */
export interface EvidenceRecord {
  runId: string;
  repo: RepoSlug;
  pr: number;
  head: string;
  baseRef: string;
  testMergeSha: string | null;
  checkRuns: EvidenceCheckRun[];
  verdictLocator: SourceTextLocator;
  reviewer: AgentIdentity;
  decision: GateDecision;
  /** The `mergeable_state` the decision judged, after any re-reads. */
  mergeableState: string;
  /** Set when the verdict was reviewed at another head and carried here: both heads and both trees. */
  carry?: CarryFact;
  ciPolicy?: CiPolicy;
  proofUnverified?: string;
}

/** The facts observed at one head, and the record of what they decided there. */
export interface MergeEvidence extends GrantWithheldField {
  head: string;
  merge: MergeFacts;
  record: EvidenceRecord;
  mergeableState: string;
  /** Why the base branch's required checks could not be read; set means the merge gates. */
  requiredChecksUnknown?: string;
  /** Facts that could not be read and were taken at their closed value; a gate's reason names them. */
  unreadFacts?: string[];
  /** Why the PR's changed files could not be read; set means the merge gates. */
  changedFilesUnread?: string;
  /** The reviewer's CI-policy line, kept beside the facts because authority reads no reviewer text. */
  ciPolicy?: CiPolicy;
}

/** Just what `decideAutoMerge` reads, so the evidence step can decide before its record exists. */
export interface DecidableEvidence extends GrantWithheldField {
  head: string;
  merge: MergeFacts;
  record: Pick<EvidenceRecord, "repo" | "pr">;
  mergeableState?: string;
  requiredChecksUnknown?: string;
  unreadFacts?: string[];
  changedFilesUnread?: string;
  ciPolicy?: CiPolicy;
}

/** Every row the merge guard gates on; the owner section words each one (why-asked.ts), as do the evidence comment and the decision class. */
export const MERGE_GUARD_ROWS = ["no-facts", "head-mismatch", "files-unread", "skill-path", "visual-path", "required-checks-unknown", "merge-state-unsettled", "github-path", "ci-policy-weakened", "ci-policy-malformed"] as const;
export type MergeGuardRow = (typeof MERGE_GUARD_ROWS)[number];

function guardRule(rowId: MergeGuardRow): PolicyRule {
  return { table: "shepherd-merge-guard", rowId, version: 1 };
}

const UNSETTLED_ROW: MergeGuardRow = "merge-state-unsettled";

/** The one gate a later read at the same head may clear: GitHub had not computed mergeability on any read. */
export function isUnsettledGate(decision: GateDecision): boolean {
  return decision.outcome === "gate" && decision.rule.table === "shepherd-merge-guard" && decision.rule.rowId === UNSETTLED_ROW;
}

function authorityRule(ruleId: string | null): PolicyRule {
  return { table: "authority", rowId: ruleId ?? "none", version: AUTHORITY_VERSION };
}

/** Folds case and trailing dots or spaces, which some filesystems ignore, so `.GitHub.` is still `.github`. */
export function isGithubPath(path: string): boolean {
  const first = path.split("/")[0] ?? "";
  return first.toLowerCase().replace(/[ .]+$/, "") === ".github";
}

/** Names the facts read at their closed value, so the owner sees why a gate fell back; an allow is left as it is. */
function withUnreadFacts(decision: GateDecision, evidence: DecidableEvidence | undefined): GateDecision {
  const unread = evidence?.unreadFacts ?? [];
  if (decision.outcome !== "gate" || unread.length === 0) return decision;
  return { ...decision, reason: `${decision.reason}; read closed: ${unread.join("; ")}` };
}

/**
 * The pure decision both the evidence step and `decide` use; only MRG-AU-RV at this exact head, MRG-AU-RC for a
 * tree-equal carry of the verdict to it, or MRG-AU-RM for a remerge-clean one, allows. A head that changes a repo skill
 * gates under any policy, and under `visualPaths` so does a head whose changed files match one, unless `visualBaselines`
 * shows no baseline changed and its check passed there.
 */
export function decideAutoMerge(headSha: string, evidence: DecidableEvidence | undefined, visualPaths?: readonly string[], visualBaselines?: VisualBaselines): GateDecision {
  return withUnreadFacts(decideOnFacts(headSha, evidence, { visualPaths, visualBaselines }), evidence);
}

interface VisualPolicy {
  visualPaths: readonly string[] | undefined;
  visualBaselines: VisualBaselines | undefined;
}

function decideOnFacts(headSha: string, evidence: DecidableEvidence | undefined, visual: VisualPolicy): GateDecision {
  if (!evidence) return { outcome: "gate", rule: guardRule("no-facts"), reason: `no merge facts were collected at ${headSha}` };
  if (evidence.head !== headSha || evidence.merge.head !== headSha) {
    return { outcome: "gate", rule: guardRule("head-mismatch"), reason: `merge facts were collected at ${evidence.head}, not ${headSha}` };
  }
  const pathGate = changedFilesGate(evidence, visual);
  if (pathGate) return pathGate;
  const policyGate = ciPolicyGate(evidence);
  if (policyGate) return policyGate;
  if (evidence.requiredChecksUnknown !== undefined) return { outcome: "gate", rule: guardRule("required-checks-unknown"), reason: evidence.requiredChecksUnknown };
  if (evidence.mergeableState === "unknown") return { outcome: "gate", rule: guardRule(UNSETTLED_ROW), reason: `mergeable_state unknown after ${SETTLE_MAX_READS} reads` };
  const decision = evaluate(DEFAULT_TABLE, { action: "merge", actor: AUTHORITY_ACTOR, tainted: false, subject: { repo: evidence.record.repo, pr: String(evidence.record.pr) }, facts: { merge: evidence.merge } });
  if (decision.verdict === "allow" && decision.ruleId !== null && AUTO_MERGE_RULES.includes(decision.ruleId)) {
    return { outcome: "allow", rule: authorityRule(decision.ruleId), reason: `${decision.ruleId} holds at ${headSha}${visualClearance(evidence, visual)}` };
  }
  const reason = decision.verdict === "allow" ? `${decision.ruleId} allows, but only ${AUTO_MERGE_RULES.join(" and ")} merge without the owner` : decision.reason;
  return { outcome: "gate", rule: authorityRule(decision.ruleId), reason: withGrantWithheld(reason, evidence) };
}

const SHOWN_VISUAL_PATHS = 10;
const MAX_SHOWN_PATH = 200;

/** Each path is flattened, as a PR author names it and a gate reason lands on one line of the owner's prompt. */
export function shownPaths(paths: readonly string[]): string {
  return paths.slice(0, SHOWN_VISUAL_PATHS).map((path) => oneLine(path, MAX_SHOWN_PATH)).join(", ") + (paths.length > SHOWN_VISUAL_PATHS ? ` and ${paths.length - SHOWN_VISUAL_PATHS} more` : "");
}

/**
 * Unread changed files gate under any policy; under visual paths they count as visual, as does an empty list. A skill
 * change gates under any policy too, with a guard row the coordinator-evidence resolve never admits, so only the owner clears it.
 */
function changedFilesGate(evidence: DecidableEvidence, { visualPaths, visualBaselines }: VisualPolicy): GateDecision | undefined {
  const asVisual = visualPaths === undefined ? "" : ", so the PR counts as visual";
  if (evidence.changedFilesUnread !== undefined) return { outcome: "gate", rule: guardRule("files-unread"), reason: `${evidence.changedFilesUnread}${asVisual}; the owner decides` };
  const skills = skillPathsIn(evidence.merge.changedPaths);
  if (skills.length > 0) return { outcome: "gate", rule: guardRule("skill-path"), reason: `${SKILL_REASON_PREFIX}${shownPaths(skills)}` };
  if (visualPaths === undefined) return undefined;
  if (evidence.merge.changedPaths.length === 0) return { outcome: "gate", rule: guardRule("files-unread"), reason: `no changed files were read at ${evidence.head}${asVisual}; the owner decides` };
  const visual = visualMatches(evidence.merge.changedPaths, visualPaths);
  if (visual.length === 0) return undefined;
  const globGate: GateDecision = { outcome: "gate", rule: guardRule("visual-path"), reason: `${VISUAL_REASON_PREFIX}${shownPaths(visual)}` };
  return visualBaselines === undefined ? globGate : baselineGate(evidence, visualBaselines, globGate);
}

/**
 * A changed baseline is a rendered diff the owner reviews; none, with the baseline check green at the head, clears the glob
 * gate. An empty list or a blank check name can show no rendered diff, so it keeps the glob gate.
 */
function baselineGate(evidence: DecidableEvidence, baselines: VisualBaselines, globGate: GateDecision): GateDecision | undefined {
  if (baselines.paths.length === 0 || baselines.check.trim() === "") return globGate;
  const changed = baselineChanges(evidence.merge.changedPaths, baselines.paths);
  if (changed.length > 0) return { outcome: "gate", rule: guardRule("visual-path"), reason: `${VISUAL_REASON_PREFIX}${shownPaths(changed)}` };
  return baselineCheckGreen(evidence.merge, baselines.check) ? undefined : globGate;
}

/** The note an allow carries when visual files were cleared by the baseline check, so the evidence comment records why. */
function visualClearance(evidence: DecidableEvidence, { visualPaths, visualBaselines }: VisualPolicy): string {
  if (visualPaths === undefined || visualBaselines === undefined) return "";
  const visual = visualMatches(evidence.merge.changedPaths, visualPaths);
  if (visual.length === 0) return "";
  return `; visual files ${shownPaths(visual)} changed no baseline and ${oneLine(visualBaselines.check, MAX_SHOWN_PATH)} passed at ${evidence.head}`;
}

/**
 * A reviewer who says CI policy is weakened, or writes the line in a shape the parser refuses, gates any PR for the owner.
 * A `.github/` change, rename sources included, with no line gates too, so a stored record from before the line existed
 * fails closed.
 */
function ciPolicyGate(evidence: DecidableEvidence): GateDecision | undefined {
  const { ciPolicy } = evidence;
  if (ciPolicy?.kind === "malformed") return { outcome: "gate", rule: guardRule("ci-policy-malformed"), reason: CI_POLICY_MALFORMED_REASON };
  if (ciPolicy?.kind === "weakened") return { outcome: "gate", rule: guardRule("ci-policy-weakened"), reason: `${CI_POLICY_WEAKENED_PREFIX}${shownPaths(ciPolicy.keys)}` };
  if (ciPolicy?.kind === "unchanged") return undefined;
  const github = evidence.merge.changedPaths.filter(isGithubPath);
  if (github.length === 0) return undefined;
  return { outcome: "gate", rule: guardRule("github-path"), reason: `${GITHUB_PATH_REASON_PREFIX}${shownPaths(github)}` };
}

/** Tests, markdown and type declarations under a visual glob change no rendered output (decision 303, Q2). */
const NON_RENDERING = /(\.(test|spec)\.[^/]*|\.md|\.d\.ts)$/;

function cannotRender(path: string): boolean {
  const name = path.toLowerCase().split("/").pop() ?? "";
  return NON_RENDERING.test(name);
}

/**
 * Case is folded on both sides, as a case-insensitive checkout writes `Packages/UI/x` into `packages/ui/`. A glob list
 * that cannot compile matches every path, so a bad policy gates instead of throwing or allowing.
 */
function visualMatches(paths: readonly string[], visualPaths: readonly string[]): string[] {
  const isVisual = caseFoldedMatcher(visualPaths);
  return paths.filter((path) => !cannotRender(path) && isVisual(path));
}

function caseFoldedMatcher(globs: readonly string[]): (path: string) => boolean {
  try {
    const matches = compileGlobs(globs.map((glob) => glob.toLowerCase()));
    return (path) => matches(path.toLowerCase());
  } catch {
    return () => true;
  }
}

/** Every status counts, as a removed or added baseline is a rendered change too; no `cannotRender` filter, as a snapshot directory may be named `.spec.`. */
function baselineChanges(paths: readonly string[], baselinePaths: readonly string[]): string[] {
  return paths.filter(caseFoldedMatcher(baselinePaths));
}

/** Every run of the check from GitHub Actions at the head concluded `success`, and there is at least one; pending reads null. */
function baselineCheckGreen(merge: MergeFacts, check: string): boolean {
  const runs = merge.checkRuns.filter((run) => run.name === check && ALLOWED_CHECK_APPS.includes(run.appId) && run.headSha === merge.head);
  return runs.length > 0 && runs.every((run) => run.conclusion === "success");
}

/** A run with no app id is counted from no app, so it cannot satisfy a required context. */
function runFact(run: CheckRun): CheckRunFact {
  return { name: run.name, appId: run.appId ?? -1, headSha: run.headSha, conclusion: run.conclusion };
}

/** GitHub's test merge exists and is clean for this very head, not for a head pushed since. */
function mergeTreeClean(pr: PullRequest, head: string, reviewBypassable: boolean): boolean {
  const mergeable = MERGEABLE.has(pr.mergeableState) || (pr.mergeableState === "blocked" && reviewBypassable);
  return pr.state === "open" && !pr.merged && pr.headSha === head && pr.mergeSha !== null && mergeable;
}

interface Bypass {
  bypassable: boolean;
  unread?: string;
}

/** GitHub reports a review-only block as `blocked`; an unreadable ruleset is not bypassable, so the merge gates. */
async function reviewBypassable(port: GitHubPort, repo: RepoSlug, pr: PullRequest): Promise<Bypass> {
  if (pr.mergeableState !== "blocked") return { bypassable: false };
  try {
    return { bypassable: await port.reviewRulesBypassable(repo, pr.baseRef) };
  } catch (error) {
    return { bypassable: false, unread: `review rules of ${repo}@${pr.baseRef} are unreadable: ${statusOf(error)}` };
  }
}

/** Only `unknown` is transient; every other state is judged on the first read. */
async function settledPr(port: GitHubPort, repo: RepoSlug, number: number, clock: SettleClock): Promise<PullRequest> {
  let pr = await port.getPr(repo, number);
  for (let read = 1; read < SETTLE_MAX_READS && pr.mergeableState === "unknown"; read++) {
    await clock.sleep(SETTLE_INTERVAL_MS);
    pr = await port.getPr(repo, number);
  }
  return pr;
}

interface Observed {
  pr: PullRequest;
  merge: MergeFacts;
  runs: CheckRun[];
  requiredChecksUnknown?: string;
  unreadFacts?: string[];
  changedFilesUnread?: string;
}

interface KindRead {
  kind?: string;
  /** Why the registration could not be read. */
  unread?: string;
}

/** A store that is not bound or fails reads as no kind, which fails MRG-AU-RC closed instead of failing the evidence step. */
export function registeredKind(store: ShepherdStoreRef, runId: string): KindRead {
  try {
    const kind = store.get().byRun(runId)?.kind;
    return kind === undefined ? {} : { kind };
  } catch (error) {
    return { unread: `the registered kind is unreadable: store unreadable: ${errorClass(error)}` };
  }
}

/** Only an equal tree probe or a carrying remerge probe for this head becomes a fact; the reviewer's text never does. */
function carryFact(carry: MergeEvidenceInput["carry"], head: string): CarryFact | undefined {
  if (!carry || carry.head !== head) return undefined;
  if (carry.rule === "remerge-empty" || carry.rule === "remerge-generated-only") return carry.remerge && remergeFact(carry.fromHead, carry.head, carry.remerge);
  const { result } = carry;
  if (!result?.equal || !result.headTree || !result.mergeTree) return undefined;
  return { fromHead: carry.fromHead, head: carry.head, headTree: result.headTree, mergeTree: result.mergeTree, rule: "tree-equal" };
}

/** Every fact is read from GitHub, the run's own step outputs or its registration (`kind`), never from the reviewer's text. */
export async function collectMergeFacts(port: GitHubPort, input: MergeEvidenceInput, isFrozen: IsFrozen, { kind, unread }: KindRead = {}, clock: SettleClock = REAL_CLOCK, reviewAppId?: number): Promise<Observed> {
  const pr = await settledPr(port, input.repo, input.pr, clock);
  const [required, runs, paths, frozen, bypassable] = await Promise.all([
    readRequiredChecks(port, input.repo, pr.baseRef),
    port.latestCheckRuns(input.repo, input.head),
    pinnedPaths(port, input, pr.headSha),
    isFrozen(input.repo, input.pr),
    reviewBypassable(port, input.repo, pr),
  ]);
  const merge: MergeFacts = {
    head: input.head,
    resolver: input.resolver,
    dispatchedReviewer: input.dispatchedReviewer,
    verdict: { value: input.verdict.value, head: input.verdict.head },
    requiredContexts: required.readable ? required.checks.contexts : [],
    allowedApps: [...ALLOWED_CHECK_APPS],
    contextApps: reviewContextApps(reviewAppId),
    checkRuns: runs.map(runFact),
    mergeTreeClean: mergeTreeClean(pr, input.head, bypassable.bypassable),
    repoFrozen: frozen,
    changedPaths: paths.paths,
    seatGrants: input.seatGrants,
  };
  const carry = carryFact(input.carry, input.head);
  if (carry) merge.carry = carry;
  if (kind !== undefined) merge.kind = kind;
  const unreadFacts = [bypassable.unread, unread].filter((fact) => fact !== undefined);
  const unknown = { ...(!required.readable && { requiredChecksUnknown: required.reason }), ...(paths.unread !== undefined && { changedFilesUnread: paths.unread }) };
  return { pr, merge, runs, ...unknown, ...(unreadFacts.length > 0 && { unreadFacts }) };
}

/** The body of the sh-merge-evidence step: observe, decide, and post one comment per head. */
export async function mergeEvidence(port: GitHubPort, input: MergeEvidenceInput, isFrozen: IsFrozen, kind?: KindRead, clock?: SettleClock, reviewAppId?: number): Promise<MergeEvidence & { commentId: number }> {
  const { pr, merge, runs, requiredChecksUnknown, unreadFacts, changedFilesUnread } = await collectMergeFacts(port, input, isFrozen, kind, clock, reviewAppId);
  const mergeableState = pr.mergeableState;
  const unknown = { ...(requiredChecksUnknown !== undefined && { requiredChecksUnknown }), ...(unreadFacts && { unreadFacts }), ...(changedFilesUnread !== undefined && { changedFilesUnread }) };
  const ciPolicy = input.ciPolicy && { ciPolicy: input.ciPolicy };
  const decidable: DecidableEvidence = { head: input.head, merge, record: input, mergeableState, ...unknown, ...ciPolicy, ...grantWithheldField(input) };
  const decision = decideAutoMerge(input.head, decidable, input.visualPaths, input.visualBaselines);
  const record: EvidenceRecord = {
    runId: input.runId,
    repo: input.repo,
    pr: input.pr,
    head: input.head,
    baseRef: pr.baseRef,
    testMergeSha: pr.mergeSha,
    checkRuns: runs.map((run) => ({ name: run.name, id: run.id, appId: run.appId, conclusion: run.conclusion })),
    verdictLocator: input.verdict.locator,
    reviewer: input.resolver,
    decision,
    mergeableState,
    ...(merge.carry && { carry: merge.carry }),
    ...ciPolicy,
    ...(input.proofUnverified !== undefined && { proofUnverified: input.proofUnverified }),
  };
  const comment = await port.upsertComment(input.repo, input.pr, evidenceMarker(input.head), evidenceComment(record));
  return { head: input.head, merge, record, mergeableState, ...unknown, ...ciPolicy, ...grantWithheldField(input), commentId: comment.id };
}
