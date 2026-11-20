import type { GateRecord } from "@titan-design/hitl";
import type { WorkflowRun } from "@titan-design/workflow";
import { isOwnerResolved, weekBounds } from "../owner-gates/audit-sample.js";
import { round } from "./owner-friction.js";
import { mergedAt } from "./stats.js";

export interface OwnerMeter {
  week: string;
  /** Runs Shepherd's own merge step landed in the week. */
  merged: number;
  /** Merged runs holding a gate an owner resolved in the week. */
  ownerGated: number;
  /** `ownerGated / merged`; null when nothing merged. */
  share: number | null;
  /** Owner-resolved gates of the week by resolver class; a delegate's resolve under a grant is in neither. */
  resolves: { ownerTerminal: number; ownerRemote: number };
}

const runOf = (gate: GateRecord): string => gate.id.slice(0, gate.id.indexOf("/"));

export function ownerMeter(runs: readonly WorkflowRun[], gates: readonly GateRecord[], week: string): OwnerMeter {
  const { start, end } = weekBounds(week);
  const within = (at: number | undefined): boolean => at !== undefined && at >= start && at < end;
  const resolved = gates.filter((gate) => isOwnerResolved(gate) && within(Date.parse(gate.resolvedAt!)));
  const gatedRuns = new Set(resolved.map(runOf));
  const merged = runs.filter((run) => within(mergedAt(run)));
  const ownerGated = merged.filter((run) => gatedRuns.has(run.id)).length;
  const countClass = (cls: string): number => resolved.filter((gate) => gate.resolvedBy?.class === cls).length;
  return {
    week,
    merged: merged.length,
    ownerGated,
    share: merged.length === 0 ? null : round(ownerGated / merged.length),
    resolves: { ownerTerminal: countClass("owner-terminal"), ownerRemote: countClass("owner-remote") },
  };
}
