import type { z } from "zod";
import { GITHUB_ACTIONS_APP_ID, headCheckFindings, latestPerName, type CheckFinding, type CheckRun, type GitHubPort, type PullRequest } from "@titan-design/github";
import type { CiSnapshotResult } from "./land-steps.js";
import { openRepoFindings, openRunsSettled, type OpenSeen } from "./land-open-checks.js";
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
}

export interface CiInput {
  repo: string;
  pr: number;
  contexts: string[];
  strict: boolean;
}

export interface CiReadOptions {
  /** Where a base that requires no check keeps the run set the last poll saw; absent means no second read is asked for. */
  openSeen?: OpenSeen;
  /** Reads true once a required check that never reported has waited out its grace; a running check still blocks. */
  missingSettled?: (headSha: string) => boolean;
}

/**
 * `reads` answers the PR and its check runs; every other read, and every write, goes to the port. A snapshot may answer
 * pending, red or behind, but its green is read again through the port, because the merge that follows acts on it.
 */
export async function readCi(port: GitHubPort, input: CiInput, reads?: PrReads, options: CiReadOptions = {}): Promise<CiSnapshot> {
  const ci = await readCiFrom(port, input, reads ?? portReads(port), options);
  if (ci.verdict !== "green" || reads === undefined) return ci;
  return readCiFrom(port, input, portReads(port), { ...options, openSeen: undefined });
}

/** An open repo's settled judgement compares two polls, so each is a live read: a cached run set would be compared with itself. */
function judgedReads(port: GitHubPort, input: CiInput, reads: PrReads, options: CiReadOptions): PrReads {
  return input.contexts.length === 0 && options.openSeen !== undefined ? { getPr: reads.getPr, checkRuns: portReads(port).checkRuns } : reads;
}

/** The runs a verdict is judged on. The snapshot settles a head on this same set: once every finding left is a failure, nothing is still running. */
function findingsAt(input: Pick<CiInput, "contexts">, headSha: string, runs: readonly CheckRun[]): CheckFinding[] {
  if (input.contexts.length === 0) return openRepoFindings(headSha, runs);
  return headCheckFindings({ headSha, contexts: input.contexts, runs, requiredApps: [GITHUB_ACTIONS_APP_ID] });
}

/** True when every required check at `headSha` has passed, as ci-wait judges them when the base names required contexts; mergeability is not read. */
export async function requiredChecksPass(input: Pick<CiInput, "repo" | "contexts">, headSha: string, reads: PrReads): Promise<boolean> {
  const runs = await reads.checkRuns(input.repo, headSha, () => true);
  return findingsAt(input, headSha, runs).length === 0;
}

async function readCiFrom(port: GitHubPort, input: CiInput, snapshotReads: PrReads, options: CiReadOptions): Promise<CiSnapshot> {
  const reads = judgedReads(port, input, snapshotReads, options);
  const pr = await reads.getPr(input.repo, input.pr);
  const base = { headSha: pr.headSha, mergeableState: pr.mergeableState };
  if (pr.merged) return { ...base, verdict: "merged", mergeSha: pr.mergeSha };
  if (pr.state === "closed") return { ...base, verdict: "closed" };
  const runs = await reads.checkRuns(input.repo, pr.headSha, (all) => findingsAt(input, pr.headSha, all).every((finding) => finding.kind === "failed"));
  const findings = findingsAt(input, pr.headSha, runs);
  if (findings.length === 0 && awaitsSecondRead(input, options, pr.headSha, runs)) return { ...base, verdict: "pending", waitingOn: ["a second read that sees the same check-runs"] };
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
function behindVerdict(base: Pick<CiSnapshot, "headSha" | "mergeableState">, findings: CheckFinding[], draft: boolean, missingSettled: boolean): CiSnapshot {
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
