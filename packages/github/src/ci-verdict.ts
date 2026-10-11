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

/** A pinned context needs a green run from each pinned app; an unpinned one accepts GitHub Actions or a commit status. */
function requiredFindings({ rules, runs, statuses }: CiVerdictInput): Finding[] {
  const findings: (Finding | null)[] = [];
  for (const context of rules.contexts) {
    const pins = rules.pins?.[context];
    if (pins) {
      findings.push(...pins.map((app) => judge(context, newest(runs, context, app), null)));
    } else {
      const state = statuses.find((status) => status.context === context)?.state ?? null;
      findings.push(judge(context, newest(runs, context, GITHUB_ACTIONS_APP_ID), state));
    }
  }
  return findings.filter((finding): finding is Finding => finding !== null);
}

function newest(runs: readonly CheckRun[], name: string, app: number): CheckRun | null {
  let best: CheckRun | null = null;
  for (const run of runs) {
    if (run.name === name && run.appId === app && (!best || (run.startedAt ?? "") > (best.startedAt ?? ""))) best = run;
  }
  return best;
}

/** A required context is green only on `success`: skipped and neutral are red here, unlike the all-runs rule. */
function judge(name: string, run: CheckRun | null, state: string | null): Finding | null {
  if ((run?.status === "completed" && run.conclusion === "success") || state === "success") return null;
  if ((run && run.status !== "completed") || state === "pending" || (!run && state === null)) return { kind: "pending", text: name };
  return { kind: "bad", text: `${name}=${run ? run.conclusion : state}` };
}

const PASSING_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

/** A status-only sha stays pending: a status can land before the check suites have even been created. */
function allFindings(runs: readonly CheckRun[], statuses: readonly CommitStatus[]): Finding[] {
  const findings: Finding[] = [];
  for (const run of runs) {
    if (run.status !== "completed") findings.push({ kind: "pending", text: run.name });
    else if (!PASSING_CONCLUSIONS.has(run.conclusion ?? "")) findings.push({ kind: "bad", text: `${run.name}=${run.conclusion}` });
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
