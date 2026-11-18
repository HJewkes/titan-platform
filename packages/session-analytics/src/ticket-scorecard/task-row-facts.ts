import { hoursBetween, round2 } from "./stats.js";
import type { ScorecardGate, ScorecardPr, ScorecardRegistration, ScorecardRun, ScorecardSpawn } from "./types.js";

/** Shepherd spawns its own fixers and reviewers; the scorecard counts only what someone else dispatched. */
const SHEPHERD_LAUNCHER = "shepherd";

/** The step families that wait for an implementer's next head, one per fix round (`step-phase.ts` maps both to fixing). */
const FIX_ROUND_FAMILIES: ReadonlySet<string> = new Set(["await-new-head", "sh-await-new-head"]);

/** A step id is `<family>` or `<family>:<call index>` (the workflow engine's key); the family names the step. */
function stepFamily(stepId: string): string {
  return stepId.split(":")[0]!;
}

/** The authority actor classes that are the owner. */
const OWNER_CLASSES: ReadonlySet<string> = new Set(["owner-terminal", "owner-remote"]);

/** The earliest spawn that dispatched the task, ties broken by spawner so the pick is stable. */
export function firstDispatch<S extends ScorecardSpawn>(spawns: readonly S[]): S | null {
  const eligible = spawns.filter((s) => s.launchedBy !== SHEPHERD_LAUNCHER);
  const sorted = [...eligible].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || compare(a.actor, b.actor));
  return sorted[0] ?? null;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function prKey(repo: string, pr: number): string {
  return `${repo.toLowerCase()}#${pr}`;
}

/** The task's PRs, counted only when a Shepherd registration names the task: a branch or title match is not proof. */
export function registeredPrs(registrations: readonly ScorecardRegistration[], prs: readonly ScorecardPr[]): ScorecardPr[] {
  const keys = new Set(registrations.map((r) => prKey(r.repo, r.pr)));
  const seen = new Set<string>();
  return prs.filter((p) => {
    const key = prKey(p.repo, p.pr);
    if (!keys.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function earliestMerge(prs: readonly ScorecardPr[]): string | null {
  const merged = prs.map((p) => p.mergedAt).filter((t): t is string => t !== null);
  return merged.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
}

/** Registered PRs closed without merging, when the task has more than one registered PR. */
export function duplicatePrs(prs: readonly ScorecardPr[]): number {
  if (prs.length < 2) return 0;
  return prs.filter((p) => p.mergedAt === null && p.closedAt !== null).length;
}

/** One round per await-new-head step, plus one per lineage successor (plan section 2, metric 17). */
export function fixRounds(runs: readonly ScorecardRun[]): number {
  return runs.reduce((acc, run) => acc + run.stepIds.filter((id) => FIX_ROUND_FAMILIES.has(stepFamily(id))).length + run.successors, 0);
}

export function reviewRounds(runs: readonly ScorecardRun[]): number {
  return runs.reduce((acc, run) => acc + run.reviewRounds, 0);
}

/** Gates the owner resolved, and the hours they stood open. */
export function ownerGates(gates: readonly ScorecardGate[]): { count: number; hours: number } {
  const owned = gates.filter((g) => g.resolvedByClass !== null && OWNER_CLASSES.has(g.resolvedByClass));
  const hours = owned.reduce((acc, g) => acc + (hoursBetween(g.createdAt, g.resolvedAt) ?? 0), 0);
  return { count: owned.length, hours: round2(hours) };
}
