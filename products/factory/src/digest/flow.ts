import type { WatchRow } from "../shepherd/view.js";
import type { FlowStats } from "./model.js";

/** One broker agent's life, as the roster reads it. `endedAt` is absent while the agent is live; an exited agent without one cannot be measured. */
export interface AgentSpan {
  profile: string;
  startedAt: string;
  endedAt?: string;
  live: boolean;
}

/** Where the flow numbers come from; tests pass fixtures, the CLI passes active-work and the agent-chat roster. */
export interface FlowPorts {
  /** The `created` date (YYYY-MM-DD) of `<initiative>/<ID>`, or undefined when the task file cannot be read. */
  taskCreated(task: string): Promise<string | undefined>;
  roster(): Promise<AgentSpan[]>;
}

const IMPLEMENTER_PROFILES: ReadonlySet<string> = new Set(["implementer", "implementer-lite", "bd-implementer"]);

const HOUR_MS = 3_600_000;
const round = (value: number, places: number): number => Math.round(value * 10 ** places) / 10 ** places;

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export const mergedInWindow = (rows: readonly WatchRow[], since: Date): WatchRow[] =>
  rows.filter((row) => row.phase === "done" && row.outcome?.kind === "merged" && Date.parse(row.phaseSince) >= since.getTime());

/** Hours from each task's created date to its run's merge; a run with no task or an unreadable one is counted in `missing`, never imputed. */
export async function taskToMerge(merged: readonly WatchRow[], taskCreated: FlowPorts["taskCreated"]): Promise<{ hours: number[]; missing: number }> {
  const hours: number[] = [];
  for (const row of merged) {
    const created = row.task.includes("/") ? await taskCreated(row.task).catch(() => undefined) : undefined;
    const start = created === undefined ? Number.NaN : Date.parse(`${created}T00:00:00Z`);
    if (Number.isNaN(start)) continue;
    hours.push((Date.parse(row.phaseSince) - start) / HOUR_MS);
  }
  return { hours, missing: merged.length - hours.length };
}

/** Implementer hours inside the window; each span is clipped to it, and an exited agent with no end time is counted apart. */
export function implementerHours(spans: readonly AgentSpan[], since: Date, now: Date): { hours: number; unmeasured: number } {
  let ms = 0;
  let unmeasured = 0;
  for (const agent of spans.filter((s) => IMPLEMENTER_PROFILES.has(s.profile))) {
    if (!agent.live && agent.endedAt === undefined) {
      unmeasured += 1;
      continue;
    }
    const start = Math.max(Date.parse(agent.startedAt), since.getTime());
    const end = Math.min(agent.endedAt === undefined ? now.getTime() : Date.parse(agent.endedAt), now.getTime());
    if (end > start) ms += end - start;
  }
  return { hours: ms / HOUR_MS, unmeasured };
}

export function flowStats(merged: readonly WatchRow[], tasks: { hours: number[]; missing: number }, slots: { hours: number; unmeasured: number }): FlowStats {
  const p50 = median(tasks.hours);
  return {
    merged: merged.length,
    missing: tasks.missing,
    ...(p50 !== undefined && { taskToMergeP50Hours: round(p50, 1) }),
    implementerHours: round(slots.hours, 2),
    unmeasured: slots.unmeasured,
    ...(slots.hours > 0 && { mergesPerSlotHour: round(merged.length / slots.hours, 2) }),
  };
}
