import type { ReportWindow } from "./cost-report-queries.js";
import type { ReviewFillReport } from "./review-fill.js";
import type { SuccessorReworkReport } from "./successor-rework.js";

interface RowsReport {
  rows: readonly unknown[];
}

type RowOf<R extends RowsReport> = R["rows"][number];

export interface ComparisonSpec<R extends RowsReport> {
  key: (row: RowOf<R>) => string;
  /** False when a window's zeros mean "no data", so every delta is null. Default: the window has rows. */
  hasData?: (report: R) => boolean;
}

export interface RowDelta<Row> {
  key: string;
  before: Row | null;
  after: Row | null;
  /** After minus before per numeric field name; null when either side is missing, null, or has no data. */
  delta: Record<string, number | null>;
}

export interface WindowComparison<R extends RowsReport> {
  before: R;
  after: R;
  rows: RowDelta<RowOf<R>>[];
}

export const REVIEW_FILL_COMPARISON: ComparisonSpec<ReviewFillReport> = {
  key: (row) => `${row.band}|${row.model}`,
};

export const SUCCESSOR_REWORK_COMPARISON: ComparisonSpec<SuccessorReworkReport> = {
  key: (row) => row.role,
  hasData: (report) => report.fileReadData && report.rows.length > 0,
};

/** Runs one report over a before and an after window and pairs their rows by key, with per-field deltas. */
export function compareWindows<R extends RowsReport>(
  run: (window: ReportWindow) => R,
  before: ReportWindow,
  after: ReportWindow,
  spec: ComparisonSpec<R>,
): WindowComparison<R> {
  const beforeReport = run(before);
  const afterReport = run(after);
  const hasData = spec.hasData ?? ((report: R) => report.rows.length > 0);
  const comparable = hasData(beforeReport) && hasData(afterReport);
  const beforeRows = keyed(beforeReport, spec);
  const afterRows = keyed(afterReport, spec);
  const keys = [...new Set([...beforeRows.keys(), ...afterRows.keys()])];
  const rows = keys.map((key) => rowDelta<RowOf<R>>(key, beforeRows.get(key) ?? null, afterRows.get(key) ?? null, comparable));
  return { before: beforeReport, after: afterReport, rows };
}

function keyed<R extends RowsReport>(report: R, spec: ComparisonSpec<R>): Map<string, RowOf<R>> {
  return new Map(report.rows.map((row) => [spec.key(row), row] as const));
}

function rowDelta<Row>(key: string, before: Row | null, after: Row | null, comparable: boolean): RowDelta<Row> {
  const delta: Record<string, number | null> = {};
  for (const field of numericFields(before, after)) {
    delta[field] = comparable ? deltaOf(fieldOf(before, field), fieldOf(after, field)) : null;
  }
  return { key, before, after, delta };
}

function numericFields(...rows: unknown[]): string[] {
  const fields = new Set<string>();
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    for (const [field, value] of Object.entries(row)) if (value === null || typeof value === "number") fields.add(field);
  }
  return [...fields];
}

function fieldOf(row: unknown, field: string): unknown {
  return row !== null && typeof row === "object" ? new Map(Object.entries(row)).get(field) : null;
}

function deltaOf(before: unknown, after: unknown): number | null {
  return typeof before === "number" && typeof after === "number" ? after - before : null;
}
