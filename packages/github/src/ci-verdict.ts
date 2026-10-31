import { isConcluded, isPassing, isSucceeded, latestPerName } from "./checks.js";
import { GITHUB_ACTIONS_APP_ID } from "./readiness.js";
import type { CheckRun, CommitStatus, GitHubPort, RepoSlug, RequiredChecks } from "./port.js";

export interface CiVerdictInput {
  /** The base branch's required contexts; an empty list judges every run and status instead. */
  rules: RequiredChecks;
  runs: readonly CheckRun[];
  statuses: readonly CommitStatus[];
}

/** `reasons` names the pending contexts, or each red one as `name=conclusion`; empty when green. */
export interface CiVerdict {
  verdict: "green" | "red" | "pending";
  reasons: string[];
}

type Finding = { kind: "pending" | "bad"; text: string };

/**
 * Pure. With required contexts, each must be green the way a merge gate judges it and other runs are ignored;
 * without any, every run and status must pass and at least one check-run must exist. Pending outranks red, so a
 * red verdict names every failure, not just the first to finish.
 */
export function ciVerdict(input: CiVerdictInput): CiVerdict {
  const findings = input.rules.contexts.length > 0 ? requiredFindings(input) : allFindings(input.runs, input.statuses);
  const pending = findings.filter((finding) => finding.kind === "pending").map((finding) => finding.text);
  if (pending.length > 0) return { verdict: "pending", reasons: pending };
  const bad = findings.map((finding) => finding.text);
  return bad.length > 0 ? { verdict: "red", reasons: bad } : { verdict: "green", reasons: [] };
}

/** Rulesets first, then classic protection; both read a free-plan 403 as none, so an empty list means the all-runs rule applies. */
export async function loadRequiredContexts(port: GitHubPort, repo: RepoSlug, branch: string): Promise<RequiredChecks> {
  const rules = await port.requiredChecks(repo, branch);
  return rules.contexts.length > 0 ? rules : port.classicRequiredChecks(repo, branch);
}

/**
 * A pinned context needs a green run from each pinned app. An unpinned one is judged on its GitHub Actions run and its
 * commit status together, since the combined status carries no time to show which is newer: a stale success status
 * must not hide a newer red or unfinished run, nor a green run a red status.
 */
function requiredFindings({ rules, runs, statuses }: CiVerdictInput): Finding[] {
  const findings: (Finding | null)[] = [];
  for (const context of rules.contexts) {
    const pins = rules.pins?.[context];
    if (pins) {
      findings.push(...pins.map((app) => judge(context, decidingRun(runs, context, app))));
    } else {
      const state = statuses.find((status) => status.context === context)?.state ?? null;
      findings.push(judgeUnpinned(context, decidingRun(runs, context, GITHUB_ACTIONS_APP_ID), state));
    }
  }
  return findings.filter((finding): finding is Finding => finding !== null);
}

/**
 * Any unfinished run of the context and app decides it, so it reads pending whatever the start times and ids say: one
 * job name shared by push and pull_request workflows can start both runs in the same second, and no ordering can prove
 * a finished run superseded an unfinished one. Once every run has completed, `latestPerName` picks the newest.
 */
function decidingRun(runs: readonly CheckRun[], name: string, app: number): CheckRun | null {
  const slot = runs.filter((run) => run.name === name && run.appId === app);
  const unfinished = slot.filter((run) => !isConcluded(run));
  return latestPerName(unfinished.length > 0 ? unfinished : slot)[0] ?? null;
}

/** A required context needs `isSucceeded`, as checks.ts documents: skipped and neutral are red here, unlike the all-runs rule. */
function judge(name: string, run: CheckRun | null): Finding | null {
  if (run && isSucceeded(run)) return null;
  if (!run || !isConcluded(run)) return { kind: "pending", text: name };
  return { kind: "bad", text: `${name}=${run.conclusion}` };
}

/** Every source that reported must succeed; pending outranks red, as in `ciVerdict`, and a red run is named first. */
function judgeUnpinned(name: string, run: CheckRun | null, state: string | null): Finding | null {
  if (!run && state === null) return { kind: "pending", text: name };
  const findings = [run ? judge(name, run) : null, judgeStatus(name, state)].filter((finding): finding is Finding => finding !== null);
  return findings.find((finding) => finding.kind === "pending") ?? findings[0] ?? null;
}

function judgeStatus(name: string, state: string | null): Finding | null {
  if (state === null || state === "success") return null;
  return state === "pending" ? { kind: "pending", text: name } : { kind: "bad", text: `${name}=${state}` };
}

/** A status-only sha stays pending: a status can land before the check suites have even been created. */
function allFindings(runs: readonly CheckRun[], statuses: readonly CommitStatus[]): Finding[] {
  const findings: Finding[] = [];
  for (const run of runs) {
    if (!isConcluded(run)) findings.push({ kind: "pending", text: run.name });
    else if (!isPassing(run)) findings.push({ kind: "bad", text: `${run.name}=${run.conclusion}` });
  }
  for (const status of statuses) {
    if (status.state === "pending") findings.push({ kind: "pending", text: status.context });
    else if (status.state !== "success") findings.push({ kind: "bad", text: `${status.context}=${status.state}` });
  }
  if (runs.length === 0 && !findings.some((finding) => finding.kind === "bad")) {
    findings.push({ kind: "pending", text: statuses.length > 0 ? "(no check-run yet)" : "(nothing reported yet)" });
  }
  return findings;
}
