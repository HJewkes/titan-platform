import type { ReportRow, RunReport } from "./report.js";

const MAX_LISTED_GATES = 5;

function failedStageLines(report: RunReport, failed: ReportRow): string[] {
  const gates = failed.checkRows.filter((check) => !check.pass && check.gate === true);
  const listed = gates.slice(0, MAX_LISTED_GATES).map((check) => `  ${check.name}: ${check.detail ?? "failed"}`);
  const more = gates.length > MAX_LISTED_GATES ? [`  and ${gates.length - MAX_LISTED_GATES} more`] : [];
  const note = gates.length === 0 && failed.notes.length > 0 ? [`  ${failed.notes[failed.notes.length - 1]}`] : [];
  return [`failed at stage ${failed.stage}`, ...listed, ...more, ...note, `record: runs/${report.runId}/failed/${failed.stage}.json`];
}

/** The lines the CLI prints when a run does not complete: where it failed and why, or where the spend cap stopped it. */
export function failureLines(report: RunReport): string[] {
  const failed = report.rows.find((row) => row.status === "failed");
  if (failed) return failedStageLines(report, failed);
  if (report.stop) return [`stopped before stage ${report.stop.stage}: $${report.stop.spentUsd.toFixed(2)} spent of a $${report.stop.capUsd.toFixed(2)} cap`];
  return [];
}
