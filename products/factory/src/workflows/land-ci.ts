import type { z } from "zod";
import { GITHUB_ACTIONS_APP_ID, headCheckFindings, isConcluded, isPassingConclusion, latestPerName, type CheckFinding, type CheckRun, type GitHubPort, type PullRequest } from "@titan-design/github";
import type { CiSnapshotResult } from "./land-steps.js";
import { openRepoFindings, openRunsSettled, type OpenSeen } from "./land-open-checks.js";
import type { HeadObserver } from "../head-guard/head-regression.js";
import type { OrphanedCheck } from "./land-orphan.js";
import { portReads, type PrReads } from "./pr-snapshot.js";

/** mergeable_state values that let a merge through; `unknown` means GitHub has not settled, and `blocked` is judged apart. */
const MERGEABLE = new Set(["clean", "unstable", "has_hooks"]);

export interface FailingCheck {
  name: string;
  conclusion: string | null;
  url: string;
  workflowRunId: number | null;
}

type CiVerdict = z.infer<typeof CiSnapshotResult>["verdict"];

export interface CiSnapshot {
  verdict: CiVerdict;
  headSha: string;
  mergeableState: string;
  /** The base the read saw; absent on a ci-wait recorded before the field. */
  baseRef?: string;
  mergeSha?: string | null;
  failing?: FailingCheck[];
  waitingOn?: string[];
  /** On a `pending` read: every check waited on exists and is queued or in progress, none red or unreported, so a slow runner explains the wait. */
  backlog?: boolean;
  /** On a `behind` read: the PR's own required checks are green at this head, so it can be reviewed before any update. */
  checksGreen?: boolean;
  /** On a `behind` read in a repo that does not require up-to-date heads: green, but the base moved after its CI started. */
  baseMoved?: boolean;
  /** When `ci-wait` returned this read, so the update budget can tell how long the base has been chased. */
  readAt?: number;
  /** The required contexts this read was judged on: the base's live list, or the recorded one when the live read failed. */
  contexts?: string[];
  /** On a `pending` read: jobs still open under a completed workflow run past the grace, which land reruns once per head. */
  orphaned?: OrphanedCheck[];
  /** On a `pending` read: the window ran out on a wait only GitHub ends, so land may wait again; `reason` is the last observation. */
  timedOut?: { afterMs: number; reason: string };
}

/** What an open repo's first or changed run set waits on: a second poll that sees the same runs. */
export const SECOND_READ = "a second read that sees the same check-runs";

export interface CiInput {
  repo: string;
  pr: number;
  contexts: string[];
  strict: boolean;
}

export interface CiReadOptions {
  /** The head the caller read last; a read that shows another head is told to `observeHead`, which changes nothing returned. */
  heldHead?: string;
  observeHead?: HeadObserver;
  /** Where a base that requires no check keeps the run set the last poll saw; absent means no second read is asked for. */
  openSeen?: OpenSeen;
  /** Reads true once a required check that never reported has waited out its grace; a running check still blocks. */
  missingSettled?: (headSha: string) => boolean;
  /** Reads the base's required contexts now, so a context the ruleset dropped mid-wait stops being waited on. */
  liveContexts?: (baseRef: string) => Promise<string[]>;
}

/**
 * `reads` answers the PR and its check runs; every other read, and every write, goes to the port. A snapshot may answer
 * pending, red or behind, but its green is read again through the port, because the merge that follows acts on it.
 */
export async function readCi(port: GitHubPort, input: CiInput, reads?: PrReads, options: CiReadOptions = {}): Promise<CiSnapshot> {
  const ci = await readCiFrom(port, input, reads ?? portReads(port), options);
  if (options.heldHead !== undefined && ci.headSha !== options.heldHead) options.observeHead?.({ repo: input.repo, pr: input.pr, held: options.heldHead, read: ci.headSha });
  if (ci.verdict !== "green" || reads === undefined) return ci;
  return readCiFrom(port, input, portReads(port), { ...options, openSeen: undefined });
}

/** An open repo's settled judgement compares two polls, so each is a live read: a cached run set would be compared with itself. */
function judgedReads(port: GitHubPort, input: CiInput, reads: PrReads, options: CiReadOptions): PrReads {
  return input.contexts.length === 0 && options.openSeen !== undefined ? { getPr: reads.getPr, checkRuns: portReads(port).checkRuns } : reads;
}

/**
 * A failed live read, or a live empty list over a recorded non-empty one, keeps the recorded list: an empty list would
 * judge by the open-repo rule, so a flaky rules read must never relax the wait.
 */
export async function liveOrRecorded(recorded: string[], live: () => Promise<string[]>): Promise<string[]> {
  try {
    const contexts = await live();
    return contexts.length === 0 && recorded.length > 0 ? recorded : contexts;
  } catch {
    return recorded;
  }
}

async function judgedInput(input: CiInput, baseRef: string, options: CiReadOptions): Promise<CiInput> {
  const { liveContexts } = options;
  if (liveContexts === undefined) return input;
  return { ...input, contexts: await liveOrRecorded(input.contexts, () => liveContexts(baseRef)) };
}

/** The runs a verdict is judged on. The snapshot settles a head on this same set: once every finding left is a failure, nothing is still running. */
function findingsAt(input: Pick<CiInput, "contexts">, headSha: string, allRuns: readonly CheckRun[]): CheckFinding[] {
  const runs = withoutSupersededCancels(withoutCancelledWorkflowRuns(allRuns));
  if (input.contexts.length === 0) return openRepoFindings(headSha, runs);
  return headCheckFindings({ headSha, contexts: input.contexts, runs, requiredApps: [GITHUB_ACTIONS_APP_ID] });
}

/**
 * A newer push cancels the older run of the same check, so that cancel is not a verdict on the head. Only a cancel is
 * dropped, and only when a newer run of that name exists: a superseded failure still counts, and a lone cancel stays red.
 */
function withoutSupersededCancels(runs: readonly CheckRun[]): CheckRun[] {
  const supersededBy = (run: CheckRun) => runs.some((other) => other !== run && other.name === run.name && other.headSha === run.headSha && other.appId === run.appId && latestPerName([run, other])[0] === other);
  return runs.filter((run) => run.conclusion !== "cancelled" || !supersededBy(run));
}

/**
 * Concurrency can cancel one of two Actions runs at a head, and an aggregate job of the cancelled run then fails on its
 * cancelled needs (td#894). Such a run is no verdict while another run at that head, sharing a job name, has neither
 * failed nor been cancelled: the live or passed run is. A failure in the other run keeps both, so a real red stays red.
 */
function withoutCancelledWorkflowRuns(runs: readonly CheckRun[]): CheckRun[] {
  const jobs = new Map<number, CheckRun[]>();
  for (const run of runs) if (run.workflowRunId !== null) jobs.set(run.workflowRunId, [...(jobs.get(run.workflowRunId) ?? []), run]);
  const standing = (own: readonly CheckRun[]) => own.every((job) => !isConcluded(job) || isPassingConclusion(job.conclusion));
  const sibling = (id: number, own: readonly CheckRun[]) => [...jobs].some(([other, theirs]) => other !== id && standing(theirs) && theirs.some((job) => own.some((mine) => mine.name === job.name)));
  const cancelled = new Set([...jobs].filter(([id, own]) => own.some((job) => job.conclusion === "cancelled") && sibling(id, own)).map(([id]) => id));
  return runs.filter((run) => run.workflowRunId === null || !cancelled.has(run.workflowRunId));
}

/** True when every required check at `headSha` has passed, as ci-wait judges them when the base names required contexts; mergeability is not read. */
export async function requiredChecksPass(input: Pick<CiInput, "repo" | "contexts">, headSha: string, reads: PrReads): Promise<boolean> {
  const runs = await reads.checkRuns(input.repo, headSha, () => true);
  return findingsAt(input, headSha, runs).length === 0;
}

async function readCiFrom(port: GitHubPort, recorded: CiInput, snapshotReads: PrReads, options: CiReadOptions): Promise<CiSnapshot> {
  const pr = await snapshotReads.getPr(recorded.repo, recorded.pr);
  const base = { headSha: pr.headSha, mergeableState: pr.mergeableState, baseRef: pr.baseRef };
  if (pr.merged) return { ...base, verdict: "merged", mergeSha: pr.mergeSha };
  if (pr.state === "closed") return { ...base, verdict: "closed" };
  const input = await judgedInput(recorded, pr.baseRef, options);
  return { ...(await judgeOpenPr(port, input, pr, judgedReads(port, input, snapshotReads, options), options)), contexts: input.contexts };
}

async function judgeOpenPr(port: GitHubPort, input: CiInput, pr: PullRequest, reads: PrReads, options: CiReadOptions): Promise<CiSnapshot> {
  const base = { headSha: pr.headSha, mergeableState: pr.mergeableState, baseRef: pr.baseRef };
  const runs = await reads.checkRuns(input.repo, pr.headSha, (all) => findingsAt(input, pr.headSha, all).every((finding) => finding.kind === "failed"));
  const findings = findingsAt(input, pr.headSha, runs);
  if (findings.length === 0 && awaitsSecondRead(input, options, pr.headSha, runs)) return { ...base, verdict: "pending", waitingOn: [SECOND_READ] };
  if ((input.strict && pr.behind) || pr.mergeableState === "behind") return behindVerdict(base, findings, pr.draft, options.missingSettled?.(pr.headSha) ?? false);
  const failing = findings.flatMap((finding) => (finding.kind === "failed" ? [failingCheck(finding.run)] : []));
  if (failing.length > 0) return { ...base, verdict: "red", failing };
  if (findings.length > 0) return { ...base, verdict: "pending", waitingOn: findings.map(findingName), ...backlogFlag(findings) };
  const verdict = await settledVerdict(port, input, pr);
  if (verdict === "green" && pr.behind && (await baseMovedSinceGreen(port, input, pr, runs))) return { ...base, verdict: "behind", checksGreen: true, baseMoved: true };
  return { ...base, verdict };
}

/** Every verdict path reads the same runs, so an open repo's first or changed run set is pending before any behind or green branching. */
function awaitsSecondRead(input: CiInput, options: CiReadOptions, headSha: string, runs: readonly CheckRun[]): boolean {
  return input.contexts.length === 0 && options.openSeen !== undefined && !openRunsSettled(options.openSeen, headSha, runs);
}

/** An update restarts CI, so a behind head is updated only once its own checks settled: one base move costs one run, not one per move. */
function behindVerdict(base: Pick<CiSnapshot, "headSha" | "mergeableState" | "baseRef">, findings: CheckFinding[], draft: boolean, missingSettled: boolean): CiSnapshot {
  const running = findings.filter((finding) => finding.kind !== "failed" && !(missingSettled && finding.kind === "missing"));
  if (running.length > 0) return { ...base, verdict: "pending", waitingOn: running.map(findingName), ...backlogFlag(running) };
  return { ...base, verdict: "behind", ...(findings.length === 0 && !draft && { checksGreen: true }) };
}

/** Reached only when rules are not strict: GitHub would merge this behind head untested against base commits newer than its green. */
async function baseMovedSinceGreen(port: GitHubPort, input: CiInput, pr: PullRequest, runs: CheckRun[]): Promise<boolean> {
  const tip = await port.getHeadSha(input.repo, pr.baseRef);
  if (!tip) return true;
  const committedAt = Date.parse((await port.getCommit(input.repo, tip)).committedAt ?? "");
  const greenAt = greenStartedAt(runs, pr.headSha, input.contexts);
  return Number.isNaN(committedAt) || greenAt === null || committedAt > greenAt;
}

/** The earliest start among the required runs that made the head green; a pull_request run tests the base as it stood then. */
function greenStartedAt(runs: CheckRun[], headSha: string, contexts: string[]): number | null {
  const required = runs.filter((run) => run.headSha === headSha && run.appId === GITHUB_ACTIONS_APP_ID && (contexts.length === 0 || contexts.includes(run.name)));
  const starts = latestPerName(required).map((run) => Date.parse(run.startedAt ?? ""));
  if (starts.length === 0 || starts.some(Number.isNaN)) return null;
  return Math.min(...starts);
}

function failingCheck(run: CheckRun): FailingCheck {
  return { name: run.name, conclusion: run.conclusion, url: run.url, workflowRunId: run.workflowRunId };
}

function findingName(finding: CheckFinding): string {
  return finding.kind === "missing" ? finding.name : finding.run.name;
}

function backlogFlag(findings: CheckFinding[]): { backlog?: true } {
  return findings.every((finding) => finding.kind === "pending") ? { backlog: true } : {};
}

/** A blocked PR is green when its only block is an approval rule the caller can bypass, which GitHub reports as blocked all the same. */
async function settledVerdict(port: GitHubPort, input: CiInput, pr: PullRequest): Promise<CiVerdict> {
  const verdict = mergeVerdict(pr);
  if (verdict === "pending" && pr.mergeableState === "blocked" && (await port.reviewRulesBypassable(input.repo, pr.baseRef))) return "green";
  return verdict;
}

function mergeVerdict(pr: PullRequest): CiVerdict {
  if (pr.draft || pr.mergeableState === "dirty") return "not-mergeable";
  return MERGEABLE.has(pr.mergeableState) ? "green" : "pending";
}
