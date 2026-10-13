import type { WindowComparison } from "./compare-windows.js";
import type { ReportWindow } from "./cost-report-queries.js";
import { LIST_PRICE_CAVEAT, table, usd } from "./render-text.js";
import type { ReviewFillReport } from "./review-fill.js";
import type { SuccessorReworkReport } from "./successor-rework.js";

const NO_FILE_READ = "No file_read data: zero rework here means no data, not no rework.";

interface WindowedReport {
  window: ReportWindow;
  rows: readonly unknown[];
}

/** Review fill as one table per band and model; it has no dollars, so no price caveat. */
export function renderReviewFillText(report: ReviewFillReport): string {
  const head = ["band", "model", "verdicts", "changes", "changes %", "errors", "error %"];
  const rows = report.rows.map((row) => [row.band, row.model, row.verdicts, row.changesRequested, percent(row.changesRate), row.verdictErrors, percent(row.errorRate)]);
  return [
    `Review fill, ${windowText(report.window)}`,
    `Unfilled ${report.unfilled}, unresolved pr_ref ${report.unresolved}`,
    table("By band and model", head, rows),
  ].join("\n\n");
}

/** Successor rework per role, with the no-data warning when the graph holds no `file_read` signal. */
export function renderSuccessorReworkText(report: SuccessorReworkReport): string {
  const head = ["role", "pairs", "boot reads/pair", "rereads/pair", "reread share", "reread cost"];
  const rows = report.rows.map((row) => [row.role, row.pairs, fixed(row.meanBootReads), fixed(row.meanRereads), percent(row.rereadShare), usd(row.rereadCostUsd)]);
  return [
    `Successor rework, ${windowText(report.window)}, first ${report.bootRequests} requests`,
    "A proxy for handoff quality, not a cost to minimise.",
    ...(report.fileReadData ? [] : [NO_FILE_READ]),
    table("By role", head, rows),
    LIST_PRICE_CAVEAT,
  ].join("\n\n");
}

/**
 * One row per key, each named column as `before → after (delta)`. A column whose name ends in
 * `Usd` prints in dollars and brings the price caveat; the rule stays report-agnostic.
 */
export function renderWindowComparisonText<R extends WindowedReport>(comparison: WindowComparison<R>, columns: readonly string[]): string {
  const rows = comparison.rows.map((row) => [row.key, ...columns.map((column) => comparisonCell(row.before, row.after, row.delta[column] ?? null, column))]);
  const sections = [
    `Before ${windowText(comparison.before.window)}, after ${windowText(comparison.after.window)}`,
    table("Before → after (Δ)", ["key", ...columns], rows),
  ];
  return [...sections, ...(columns.some(isUsd) ? [LIST_PRICE_CAVEAT] : [])].join("\n\n");
}

function comparisonCell(before: unknown, after: unknown, delta: number | null, column: string): string {
  const format = (value: unknown) => (typeof value === "number" ? amount(value, column) : "-");
  const signed = delta === null ? "-" : `${delta > 0 ? "+" : delta < 0 ? "-" : ""}${amount(Math.abs(delta), column)}`;
  return `${format(fieldOf(before, column))} → ${format(fieldOf(after, column))} (${signed})`;
}

function fieldOf(row: unknown, field: string): unknown {
  return row !== null && typeof row === "object" ? new Map(Object.entries(row)).get(field) : null;
}

function amount(value: number, column: string): string {
  return isUsd(column) ? usd(value) : fixed(value);
}

function isUsd(column: string): boolean {
  return column.endsWith("Usd");
}

function fixed(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function percent(fraction: number | null): string {
  return fraction === null ? "-" : `${(fraction * 100).toFixed(1)}%`;
}

function windowText(window: ReportWindow): string {
  return `${window.since ?? "start"} to ${window.until ?? "now"}`;
}
