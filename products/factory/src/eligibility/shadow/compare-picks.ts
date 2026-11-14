import type { LedgerPick, SpawnRead } from "./compare-read.js";

/*
 * The operator's real picks for one day (TP-5755 S9): each task once, at its first spawn that day. A spawn whose role
 * marks a review, fix round, planner look or the operator's own coordinator is not a pick, and is counted so the
 * exclusion stays visible.
 */

const NON_PICK_ROLE = /^(coordinator|reviewer|shepherd-review|planner|fix-round(-\d+)?)$/;

/** `bd-tp-123`, `bd-tp-123-a` (from `agentNameFor`) and `tpo-tp123-s2`: a prefix, then the task's letters and number. */
const TASK_IN_NAME = /^[a-z0-9]+-([a-z]+)-?(\d+)(?:-|$)/i;

export interface PickScope {
  /** Initiatives with at least one configured lane; a spawn elsewhere is out of scope. */
  initiatives: ReadonlySet<string>;
  prefixes: Readonly<Record<string, string>>;
}

export interface OperatorPick {
  task: string;
  at: number;
  source: "eventsDb" | "ledger";
}

export interface PickCounts {
  found: number;
  withTask: number;
  withoutTask: number;
  excludedByRole: number;
  unresolved: number;
  outOfScope: number;
}

export function taskIdFromName(name: string | null): string | null {
  const match = name === null ? null : TASK_IN_NAME.exec(name);
  return match === null ? null : `${match[1]!.toUpperCase()}-${match[2]!}`;
}

/** A canonical `initiative/ID`: `meta.briefing` names the initiative when set, else the id's prefix through the map. */
export function resolveSpawnTask(spawn: SpawnRead, prefixes: PickScope["prefixes"]): string | null {
  const bare = spawn.task ?? taskIdFromName(spawn.name);
  if (bare === null) return null;
  if (bare.includes("/")) return bare;
  const initiative = spawn.briefing ?? prefixes[bare.split("-")[0]!.toUpperCase()];
  return initiative === undefined ? null : `${initiative}/${bare.toUpperCase()}`;
}

const isPickRole = (spawn: SpawnRead): boolean => spawn.role === null || !NON_PICK_ROLE.test(spawn.role);

/** Every in-scope spawn that is a pick, in time order, with the counts behind the filter. */
export function scopedSpawns(spawns: readonly SpawnRead[], scope: PickScope): { picks: OperatorPick[]; counts: PickCounts } {
  const counts: PickCounts = { found: spawns.length, withTask: 0, withoutTask: 0, excludedByRole: 0, unresolved: 0, outOfScope: 0 };
  const picks: OperatorPick[] = [];
  for (const spawn of spawns) {
    counts[spawn.task === null ? "withoutTask" : "withTask"] += 1;
    if (!isPickRole(spawn)) {
      counts.excludedByRole += 1;
      continue;
    }
    const task = resolveSpawnTask(spawn, scope.prefixes);
    if (task === null) counts.unresolved += 1;
    else if (!scope.initiatives.has(task.split("/")[0]!)) counts.outOfScope += 1;
    else picks.push({ task, at: spawn.ts, source: "eventsDb" });
  }
  return { picks, counts };
}

/** First pick per task inside `[from, to)`; a ledger claim adds a task only when no spawn row named it. */
export function firstPicks(spawned: readonly OperatorPick[], ledger: readonly LedgerPick[], from: number, to: number, scope: PickScope): OperatorPick[] {
  const first = new Map<string, OperatorPick>();
  const inDay = (at: number) => at >= from && at < to;
  for (const pick of [...spawned].sort((a, b) => a.at - b.at)) if (inDay(pick.at) && !first.has(pick.task)) first.set(pick.task, pick);
  for (const claim of ledger) {
    const inScope = scope.initiatives.has(claim.task.split("/")[0]!);
    if (inScope && inDay(claim.at) && !first.has(claim.task)) first.set(claim.task, { task: claim.task, at: claim.at, source: "ledger" });
  }
  return [...first.values()].sort((a, b) => a.at - b.at);
}
