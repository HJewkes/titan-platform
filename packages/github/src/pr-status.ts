import { latestPerName } from "./checks.js";
import { loadRequiredContexts } from "./ci-verdict.js";
import type { CheckRun, GitHubPort, PullRequest, RepoSlug, RequiredChecks } from "./port.js";
import { GITHUB_ACTIONS_APP_ID, mergeReadiness, type MergeBlocker } from "./readiness.js";

interface RequiredCheckState {
  name: string;
  /** The latest counted run's conclusion, its status while it runs, or `missing` when none ran at the head. */
  state: string;
}

interface PrStatus {
  repo: RepoSlug;
  number: number;
  state: "open" | "closed" | "merged" | "draft";
  headSha: string;
  baseRef: string;
  mergeableState: string;
  checks: RequiredCheckState[];
  ready: boolean;
  blockers: MergeBlocker[];
}

/** Reads the PR, its base's required checks and the head's runs, then judges them with `mergeReadiness`. */
export async function prStatus(port: GitHubPort, repo: RepoSlug, number: number): Promise<PrStatus> {
  const pr = await port.getPr(repo, number);
  const [rules, runs] = await Promise.all([loadRequiredContexts(port, repo, pr.baseRef), port.checkRuns(repo, pr.headSha)]);
  const requiredApps = appsOf(rules);
  // Approval lives in Shepherd, not on GitHub, so this reader treats the head as approved and never reports `unapproved`.
  const readiness = mergeReadiness({ pr, rules, runs, requiredApps, approvedHead: pr.headSha });
  return {
    repo,
    number: pr.number,
    state: stateOf(pr),
    headSha: pr.headSha,
    baseRef: pr.baseRef,
    mergeableState: pr.mergeableState,
    checks: requiredCheckStates(rules.contexts, runs.filter((run) => run.headSha === pr.headSha && run.appId !== null && requiredApps.includes(run.appId))),
    ready: readiness.ready,
    blockers: readiness.blockers,
  };
}

/** `owner/repo#N <state> <head7> <mergeableState> checks <pass>/<total> [<name>:<state> ...] ready|blocked: <reasons>` */
export function formatPrStatus(status: PrStatus): string {
  const passing = status.checks.filter((check) => check.state === "success");
  const failing = status.checks.filter((check) => check.state !== "success").map((check) => `${check.name}:${check.state}`);
  const verdict = status.ready ? "ready" : `blocked: ${[...new Set(status.blockers.map((blocker) => blocker.reason))].join(", ")}`;
  return [`${status.repo}#${status.number}`, status.state, status.headSha.slice(0, 7), status.mergeableState, `checks ${passing.length}/${status.checks.length}`, ...failing, verdict].join(" ");
}

function appsOf(rules: RequiredChecks): number[] {
  return [...new Set([GITHUB_ACTIONS_APP_ID, ...Object.values(rules.pins ?? {}).flat()])];
}

function stateOf(pr: PullRequest): PrStatus["state"] {
  if (pr.merged) return "merged";
  if (pr.state === "closed") return "closed";
  return pr.draft ? "draft" : "open";
}

function requiredCheckStates(contexts: readonly string[], counted: readonly CheckRun[]): RequiredCheckState[] {
  const latest = latestPerName(counted);
  return contexts.map((name) => {
    const run = latest.find((candidate) => candidate.name === name);
    if (!run) return { name, state: "missing" };
    return { name, state: run.status === "completed" ? (run.conclusion ?? "none") : run.status };
  });
}
