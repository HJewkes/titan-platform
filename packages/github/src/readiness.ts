import { isPassing } from "./checks.js";
import type { CheckRun, PullRequest, RequiredChecks } from "./port.js";

/** The GitHub Actions app; on this owner's repos every required check comes from it. */
export const GITHUB_ACTIONS_APP_ID = 15368;

export type MergeBlockReason = "merged" | "closed" | "draft" | "no-required-checks" | "unapproved" | "head-moved" | "behind" | "conflict" | "mergeability-unknown" | "check-pending" | "check-failed";

export interface MergeBlocker {
  reason: MergeBlockReason;
  detail: string;
}

export interface MergeReadinessInput {
  pr: PullRequest;
  rules: RequiredChecks;
  /** Check runs from any app at any sha; only runs from `requiredApps` at `pr.headSha` count. */
  runs: readonly CheckRun[];
  requiredApps: readonly number[];
  /** The head the approval named; null when nothing is approved. */
  approvedHead: string | null;
}

/** `ready` is true exactly when `blockers` is empty; every blocker says why. */
export interface MergeReadiness {
  ready: boolean;
  blockers: MergeBlocker[];
}

/** Pure: decides from the snapshot it is given, so the caller controls when GitHub is read. */
export function mergeReadiness(input: MergeReadinessInput): MergeReadiness {
  const blockers = [...prBlockers(input.pr, input.rules), ...approvalBlockers(input.pr, input.approvedHead), ...checkBlockers(input)];
  return { ready: blockers.length === 0, blockers };
}

function prBlockers(pr: PullRequest, rules: RequiredChecks): MergeBlocker[] {
  if (pr.merged) return [{ reason: "merged", detail: `#${pr.number} is already merged` }];
  if (pr.state === "closed") return [{ reason: "closed", detail: `#${pr.number} is closed` }];
  const blockers: MergeBlocker[] = [];
  if (pr.draft) blockers.push({ reason: "draft", detail: `#${pr.number} is a draft` });
  if (rules.strict && pr.behind) blockers.push({ reason: "behind", detail: `${pr.headRef} is behind ${pr.baseRef} and the rules require it up to date` });
  if (pr.mergeableState === "dirty") blockers.push({ reason: "conflict", detail: `${pr.headRef} conflicts with ${pr.baseRef}` });
  if (pr.mergeableState === "unknown") blockers.push({ reason: "mergeability-unknown", detail: "GitHub has not computed mergeability yet" });
  return blockers;
}

function approvalBlockers(pr: PullRequest, approvedHead: string | null): MergeBlocker[] {
  if (pr.merged || pr.state === "closed") return [];
  if (approvedHead === null) return [{ reason: "unapproved", detail: `no approval names a head of #${pr.number}` }];
  if (approvedHead !== pr.headSha) return [{ reason: "head-moved", detail: `approved ${approvedHead} but the head is ${pr.headSha}` }];
  return [];
}

/**
 * Only runs from an allowed app at the PR head count, as in authority's MRG-AU-RV. Every counted run
 * must be green, superseded or not, and each required context needs a completed run concluding success.
 */
function checkBlockers({ pr, rules, runs, requiredApps }: MergeReadinessInput): MergeBlocker[] {
  if (pr.merged || pr.state === "closed") return [];
  if (rules.contexts.length === 0) return [{ reason: "no-required-checks", detail: "the rules name no required check context, so nothing proves the head green" }];
  const counted = runs.filter((run) => run.headSha === pr.headSha && run.appId !== null && requiredApps.includes(run.appId));
  const apps = requiredApps.join(", ") || "none";
  return [...rules.contexts.flatMap((name) => requiredBlockers(name, counted, pr.headSha, apps)), ...counted.filter((run) => !isPassing(run)).map(runBlocker)];
}

/** Non-green runs are reported by `runBlocker`; this adds only what a missing or merely green required run lacks. */
function requiredBlockers(name: string, counted: readonly CheckRun[], headSha: string, apps: string): MergeBlocker[] {
  const named = counted.filter((run) => run.name === name);
  if (named.some(isSucceeded)) return [];
  if (named.length === 0) return [{ reason: "check-pending", detail: `${name} has no completed run at ${headSha} from app ${apps}` }];
  return named.every(isPassing) ? named.map(failedBlocker) : [];
}

function isSucceeded(run: CheckRun): boolean {
  return run.status === "completed" && run.conclusion === "success";
}

function runBlocker(run: CheckRun): MergeBlocker {
  return run.status === "completed" ? failedBlocker(run) : { reason: "check-pending", detail: `${run.name} is ${run.status} at ${run.headSha}` };
}

function failedBlocker(run: CheckRun): MergeBlocker {
  return { reason: "check-failed", detail: `${run.name} concluded ${run.conclusion ?? "none"} (${run.url})` };
}
