import { createHash } from "node:crypto";
import { compileGlobs } from "@titan-design/fix-proof";
import { DEFAULT_TABLE, evaluate, type AgentIdentity, type CarryFact, type CheckRunFact, type MergeFacts } from "@titan-design/authority";
import { FileListTruncatedError, GITHUB_ACTIONS_APP_ID, type CheckRun, type GitHubPort, type PrFile, type PullRequest, type RepoSlug } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { readRequiredChecks, statusOf } from "../required-checks.js";
import type { GateDecision, PolicyRule } from "../gate-policy.js";
import { errorClass } from "./error-class.js";
import { REVIEW_CHECK_NAME } from "./publish-review.js";
import type { ShepherdStoreRef } from "./store.js";
import { remergeFact, type CarryRule, type RemergeResult } from "./remerge-carry.js";
import type { CarryResult } from "./tree-carry.js";

export const MERGE_EVIDENCE_STEP = "sh-merge-evidence";

/** The rules that let Shepherd merge without the owner; any other allow still gates. */
export const MERGE_BY_REVIEWER_RULE = "MRG-AU-RV";
export const MERGE_BY_CARRIED_VERDICT_RULE = "MRG-AU-RC";
export const MERGE_BY_REMERGED_VERDICT_RULE = "MRG-AU-RM";
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

export interface MergeEvidenceInput {
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
}

/** The facts observed at one head, and the record of what they decided there. */
export interface MergeEvidence {
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
}

/** Just what `decideAutoMerge` reads, so the evidence step can decide before its record exists. */
export interface DecidableEvidence {
  head: string;
  merge: MergeFacts;
  record: Pick<EvidenceRecord, "repo" | "pr">;
  mergeableState?: string;
  requiredChecksUnknown?: string;
  unreadFacts?: string[];
  changedFilesUnread?: string;
}

function guardRule(rowId: string): PolicyRule {
  return { table: "shepherd-merge-guard", rowId, version: 1 };
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
 * The pure decision both the evidence step and `decide` use; only MRG-AU-RV at this exact head, or MRG-AU-RC for a
 * tree-equal carry of the verdict to it, allows. Under `visualPaths`, a head whose changed files match one gates.
 */
export function decideAutoMerge(headSha: string, evidence: DecidableEvidence | undefined, visualPaths?: readonly string[]): GateDecision {
  return withUnreadFacts(decideOnFacts(headSha, evidence, visualPaths), evidence);
}

function decideOnFacts(headSha: string, evidence: DecidableEvidence | undefined, visualPaths: readonly string[] | undefined): GateDecision {
  if (!evidence) return { outcome: "gate", rule: guardRule("no-facts"), reason: `no merge facts were collected at ${headSha}` };
  if (evidence.head !== headSha || evidence.merge.head !== headSha) {
    return { outcome: "gate", rule: guardRule("head-mismatch"), reason: `merge facts were collected at ${evidence.head}, not ${headSha}` };
  }
  const pathGate = changedFilesGate(evidence, visualPaths);
  if (pathGate) return pathGate;
  if (evidence.requiredChecksUnknown !== undefined) return { outcome: "gate", rule: guardRule("required-checks-unknown"), reason: evidence.requiredChecksUnknown };
  if (evidence.mergeableState === "unknown") return { outcome: "gate", rule: guardRule("merge-state-unsettled"), reason: `mergeable_state unknown after ${SETTLE_MAX_READS} reads` };
  const decision = evaluate(DEFAULT_TABLE, { action: "merge", actor: AUTHORITY_ACTOR, tainted: false, subject: { repo: evidence.record.repo, pr: String(evidence.record.pr) }, facts: { merge: evidence.merge } });
  if (decision.verdict === "allow" && decision.ruleId !== null && AUTO_MERGE_RULES.includes(decision.ruleId)) {
    return { outcome: "allow", rule: authorityRule(decision.ruleId), reason: `${decision.ruleId} holds at ${headSha}` };
  }
  const reason = decision.verdict === "allow" ? `${decision.ruleId} allows, but only ${AUTO_MERGE_RULES.join(" and ")} merge without the owner` : decision.reason;
  return { outcome: "gate", rule: authorityRule(decision.ruleId), reason };
}

const SHOWN_VISUAL_PATHS = 10;

/** Unread changed files gate under any policy; under visual paths they count as visual, as does an empty list. */
function changedFilesGate(evidence: DecidableEvidence, visualPaths: readonly string[] | undefined): GateDecision | undefined {
  const asVisual = visualPaths === undefined ? "" : ", so the PR counts as visual";
  if (evidence.changedFilesUnread !== undefined) return { outcome: "gate", rule: guardRule("files-unread"), reason: `${evidence.changedFilesUnread}${asVisual}; the owner decides` };
  if (visualPaths === undefined) return undefined;
  if (evidence.merge.changedPaths.length === 0) return { outcome: "gate", rule: guardRule("files-unread"), reason: `no changed files were read at ${evidence.head}${asVisual}; the owner decides` };
  const visual = visualMatches(evidence.merge.changedPaths, visualPaths);
  if (visual.length === 0) return undefined;
  const shown = visual.slice(0, SHOWN_VISUAL_PATHS).join(", ") + (visual.length > SHOWN_VISUAL_PATHS ? ` and ${visual.length - SHOWN_VISUAL_PATHS} more` : "");
  return { outcome: "gate", rule: guardRule("visual-path"), reason: `the owner decides visual changes: ${shown}` };
}

/**
 * Case is folded on both sides, as a case-insensitive checkout writes `Packages/UI/x` into `packages/ui/`. A glob list
 * that cannot compile matches every path, so a bad policy gates instead of throwing or allowing.
 */
function visualMatches(paths: readonly string[], visualPaths: readonly string[]): string[] {
  let isVisual: (path: string) => boolean;
  try {
    isVisual = compileGlobs(visualPaths.map((glob) => glob.toLowerCase()));
  } catch {
    isVisual = () => true;
  }
  return paths.filter((path) => isVisual(path.toLowerCase()));
}

/** Both sides of every rename, so moving a file out of `.github/` still counts as touching it. */
export function changedPaths(files: readonly PrFile[]): string[] {
  return files.flatMap((file) => (file.previousPath === undefined ? [file.path] : [file.path, file.previousPath]));
}

interface PathsRead {
  paths: string[];
  /** Why the list could not be read whole. */
  unread?: string;
}

/**
 * A truncated or failed list is no list: empty paths fail authority's path condition, and the unread reason gates first.
 * GitHub lists a PR's files at whatever head it has now, so the list counts only when the PR sits at `head` both before
 * and after it is read. The compare endpoint would pin the sha itself, but it drops rename sources and stops at 300 files.
 */
async function pinnedPaths(port: GitHubPort, { repo, pr, head }: MergeEvidenceInput, readHead: string): Promise<PathsRead> {
  const unread = (why: string): PathsRead => ({ paths: [], unread: `the changed files of ${repo}#${pr} are unknown: ${why}` });
  if (readHead !== head) return unread(`the PR is at ${readHead}, not ${head}`);
  try {
    const files = await port.listPrFiles(repo, pr);
    const after = (await port.getPr(repo, pr)).headSha;
    return after === head ? { paths: changedPaths(files) } : unread(`the head moved to ${after} during the read`);
  } catch (error) {
    return unread(error instanceof FileListTruncatedError ? "the list is truncated" : `the read failed: ${statusOf(error)}`);
  }
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

/** One marker per head, so a replay or a second run at the same head finds the comment instead of posting again. */
export function evidenceMarker(head: string): string {
  return `<!-- shepherd-evidence:${head} -->`;
}

/** What a public PR comment may say about a verdict locator: no namespace, path or source id. */
export interface LocatorReference {
  sessionId: string;
  byteOffset?: number;
  subrecordIndex?: number;
  textIndex?: number;
  locatorSha256: string;
}

const SESSION_ID = /^(?!\.\.$)[^/@\\%]{1,64}$/;

function integer(value: unknown): number | undefined {
  return Number.isInteger(value) ? (value as number) : undefined;
}

type PartialLocator = { source?: { conversation?: { nativeId?: string } }; evidence?: { line?: { byteOffset?: number }; subrecord?: { index?: number } }; selector?: { textIndex?: number } };

/** Enough to find the message in the local store: the session, the record offset, the part, and a hash that checks the full locator. */
export function locatorReference(locator: SourceTextLocator): LocatorReference {
  const { source, evidence, selector }: PartialLocator = locator;
  const position = { byteOffset: integer(evidence?.line?.byteOffset), subrecordIndex: integer(evidence?.subrecord?.index), textIndex: integer(selector?.textIndex) };
  const nativeId: unknown = source?.conversation?.nativeId;
  return {
    sessionId: typeof nativeId === "string" && SESSION_ID.test(nativeId) ? nativeId : "unknown",
    ...Object.fromEntries(Object.entries(position).filter(([, value]) => value !== undefined)),
    // The hash covers JSON.stringify in the locator's own key order, so only the reader that produced it can recompute it.
    locatorSha256: createHash("sha256").update(JSON.stringify(locator)).digest("hex"),
  };
}

export function evidenceComment(record: EvidenceRecord): string {
  const { decision } = record;
  const carried = record.carry ? ` Carried the MERGE reviewed at \`${record.carry.fromHead}\` by ${record.carry.rule ?? "tree-equal"} (merge-tree \`${record.carry.mergeTree}\`) to a head whose tree is \`${record.carry.headTree}\`.` : "";
  const summary = `Shepherd merge evidence at \`${record.head}\`: **${decision.outcome}** by ${decision.rule.table}/${decision.rule.rowId}. ${decision.reason}${carried}`;
  const posted = { ...record, verdictLocator: locatorReference(record.verdictLocator) };
  return [evidenceMarker(record.head), summary, "", "```json", JSON.stringify(posted, null, 2), "```", ""].join("\n");
}

/** The body of the sh-merge-evidence step: observe, decide, and post one comment per head. */
export async function mergeEvidence(port: GitHubPort, input: MergeEvidenceInput, isFrozen: IsFrozen, kind?: KindRead, clock?: SettleClock, reviewAppId?: number): Promise<MergeEvidence & { commentId: number }> {
  const { pr, merge, runs, requiredChecksUnknown, unreadFacts, changedFilesUnread } = await collectMergeFacts(port, input, isFrozen, kind, clock, reviewAppId);
  const mergeableState = pr.mergeableState;
  const unknown = { ...(requiredChecksUnknown !== undefined && { requiredChecksUnknown }), ...(unreadFacts && { unreadFacts }), ...(changedFilesUnread !== undefined && { changedFilesUnread }) };
  const decision = decideAutoMerge(input.head, { head: input.head, merge, record: input, mergeableState, ...unknown }, input.visualPaths);
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
  };
  const comment = await port.upsertComment(input.repo, input.pr, evidenceMarker(input.head), evidenceComment(record));
  return { head: input.head, merge, record, mergeableState, ...unknown, commentId: comment.id };
}
