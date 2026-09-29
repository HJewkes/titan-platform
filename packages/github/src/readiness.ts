import { evaluateChecks, isPassing, latestPerName } from "./checks.js";
import type { CheckRun, PullRequest, RequiredChecks } from "./port.js";

/** The GitHub Actions app; on this owner's repos every required check comes from it. */
export const GITHUB_ACTIONS_APP_ID = 15368;

export type MergeBlockReason = "merged" | "closed" | "draft" | "unapproved" | "head-moved" | "behind" | "conflict" | "mergeability-unknown" | "check-pending" | "check-failed";

export interface MergeBlocker {
  reason: MergeBlockReason;
  detail: string;
}

export interface MergeReadinessInput {
  pr: PullRequest;
  rules: RequiredChecks;
  /** Every check run on `pr.headSha`, from any app; only `requiredApps` count. */
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

/** A run from any other app never satisfies a context, and a non-green run from an allowed app blocks even when not required. */
function checkBlockers({ pr, rules, runs, requiredApps }: MergeReadinessInput): MergeBlocker[] {
  if (pr.merged || pr.state === "closed") return [];
  const allowed = latestPerName(runs.filter((run) => run.appId !== null && requiredApps.includes(run.appId)));
  const verdict = evaluateChecks(rules.contexts, allowed);
  const required = new Set(rules.contexts);
  const optionalRed = allowed.filter((run) => !required.has(run.name) && run.status === "completed" && !isPassing(run));
  const apps = requiredApps.join(", ") || "none";
  return [
    ...verdict.pending.map((name) => ({ reason: "check-pending" as const, detail: `${name} has no completed run from app ${apps}` })),
    ...[...verdict.failing, ...optionalRed].map((run) => ({ reason: "check-failed" as const, detail: `${run.name} concluded ${run.conclusion ?? "none"} (${run.url})` })),
  ];
}
