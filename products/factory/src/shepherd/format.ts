import type { MergeEvaluation, Registered } from "./commands.js";
import type { PrTimeline, TimelineEntry, WatchRow } from "./view.js";

/** The human form of each `titan-factory shepherd` verb's result; `--json` prints the result itself instead. */
export function formatShepherd(name: string, data: unknown): string {
  switch (name) {
    case "shepherd.register":
      return formatRegistered(data as Registered);
    case "shepherd.status":
    case "shepherd.list":
      return formatRows(data as WatchRow[]);
    case "shepherd.timeline":
      return formatTimeline(data as PrTimeline);
    case "shepherd.merge":
      return formatMerge(data as MergeEvaluation);
    default: {
      const { runId, held } = data as { runId: string; held: { reason: string } | null };
      return `run ${runId}: ${held ? `held (${held.reason})` : "released"}\n`;
    }
  }
}

function formatRegistered({ runId, created, registration }: Registered): string {
  const target = `${registration.repo}${registration.pr === null ? "" : `#${registration.pr}`}${registration.branch ? ` (${registration.branch})` : ""}`;
  return `run ${runId} shepherd-pr ${target}: ${created ? "started" : "already registered, metadata updated"}; policy ${registration.policy.merge}\n`;
}

function rowLine(row: WatchRow): string {
  const target = row.pr === null ? `${row.repo} ${row.branch}` : `${row.repo}#${row.pr}`;
  const head = row.headSha === null ? "-" : row.headSha.slice(0, 7);
  const blockers = [row.held && `held: ${row.held.reason}`, row.stalled && `stalled: ${row.stalled.reason}`].filter(Boolean);
  return `${target} ${row.phase} ${head} ${row.nextAction}${blockers.length > 0 ? ` [${blockers.join("; ")}]` : ""}`;
}

function formatRows(rows: WatchRow[]): string {
  return rows.length === 0 ? "no shepherded PRs\n" : `${rows.map(rowLine).join("\n")}\n`;
}

function entryLine(entry: TimelineEntry): string {
  if (entry.kind === "step") return `  step ${entry.stepId} ${entry.status}${entry.completedAt ? ` ${entry.completedAt}` : ""}`;
  if (entry.kind === "ci") return `  ci ${entry.stepId} ${entry.headSha.slice(0, 7)} ${entry.conclusion}`;
  if (entry.kind === "gate") return `  gate ${entry.gateId} ${entry.status}${entry.resolvedBy ? ` by ${entry.resolvedBy}` : ""}`;
  return `  ${entry.kind} ${entry.stepId}`;
}

function formatTimeline({ row, entries }: PrTimeline): string {
  return `${[rowLine(row), ...entries.map(entryLine)].join("\n")}\n`;
}

function formatMerge({ runId, phase, decision, held, waiting }: MergeEvaluation): string {
  return `run ${runId} ${phase}: policy says ${decision.outcome} (${decision.reason}); ${held ? `held: ${held.reason}; ` : ""}${waiting}\n`;
}
