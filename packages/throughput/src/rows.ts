/** Agent-hours under the extractor's headline idle cap. */
export interface CappedHoursLike {
  capped: number;
}

/**
 * One done task's actuals. Structural on purpose: a `taskActuals` row from
 * `@titan-design/session-analytics`, spread with the task's `kind` and `estimate`, fits as is.
 */
export interface ThroughputRow {
  taskId: string;
  initiative: string;
  /** An ISO datetime or a bare date. */
  doneAt: string;
  implAgentHours: CappedHoursLike;
  reviewAgentHours: CappedHoursLike;
  usd: number;
  kind?: string | null;
  estimate?: number | null;
  flags?: readonly string[];
}

/** The plan-time facts that place a task in a class. */
export interface TaskClassFacts {
  kind?: string | null;
  estimate?: number | null;
  initiative?: string | null;
}

export type SizeBand = "<=1" | "2" | "3" | ">=4" | "none";

export const UNTAGGED = "untagged";

// The estimate field is used in points in practice, so it is only an ordinal band here.
export function sizeBand(estimate: number | null | undefined): SizeBand {
  if (estimate === null || estimate === undefined || Number.isNaN(estimate)) return "none";
  if (estimate <= 1) return "<=1";
  if (estimate <= 2) return "2";
  if (estimate <= 3) return "3";
  return ">=4";
}

export function normalizeKind(kind: string | null | undefined): string {
  const trimmed = kind?.trim().toLowerCase();
  return trimmed ? trimmed : UNTAGGED;
}

export function classKey(kind: string, band: SizeBand): string {
  return `${kind}/${band}`;
}

/** Rows with no linked implementer session are closures, not work, so they carry no hours. */
export function isEligible(row: ThroughputRow): boolean {
  return !row.flags?.includes("no-impl-session");
}
