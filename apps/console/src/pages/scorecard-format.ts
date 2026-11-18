import type { ScorecardCell, ScorecardWeek } from "../../server/scorecard-schema.js";

/** A figure the job could not measure: never shown as zero. */
export const NOT_MEASURED = "not measured";

export const shareText = (value: number | null): string => (value === null ? NOT_MEASURED : `${Math.round(value * 100)}%`);

export const hoursText = (value: number | null): string => (value === null ? NOT_MEASURED : value < 48 ? `${Math.round(value)}h` : `${(value / 24).toFixed(1)}d`);

export const usdText = (value: number | null): string => (value === null ? NOT_MEASURED : `$${value.toFixed(2)}`);

export const numberText = (value: number | null): string => (value === null ? NOT_MEASURED : String(Math.round(value * 100) / 100));

/** The red-week flags in words a phone reader takes in at a glance; an unknown flag shows as its own id. */
const FLAG_TEXT: Readonly<Record<string, string>> = {
  "upkeep-cap": "upkeep over cap",
  "owner-floor": "owner share under floor",
  "rule-agreement": "rule agreement low",
  cost: "cost per merge over cap",
};

export const flagText = (flag: string): string => FLAG_TEXT[flag] ?? flag;

/** `2026-W45` reads as `W45` on the strip; the year shows in the section title. */
export const shortWeek = (isoWeek: string): string => isoWeek.slice(isoWeek.indexOf("-") + 1);

export const allCell = (week: ScorecardWeek): ScorecardCell | undefined => week.cells.find((cell) => cell.dimension === "all");

export const isInferredOrigin = (origin: string | undefined): boolean => origin !== undefined && origin !== "recorded";
