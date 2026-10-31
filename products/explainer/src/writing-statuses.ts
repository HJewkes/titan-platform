import { readFileSync } from "node:fs";
import { z } from "zod";
import type { WritingStatus } from "./writing-status.js";

const STATUS = z.enum(["drop", "gate", "warning", "report-only"]);

// Only the statuses and bucket bounds, never the AUCs, so a consumer cannot steer on them (TP-4662 §6.1). The file
// is read here rather than through writing-calibrate's parser so lint-register does not import its own calibrator.
const StatusTableSchema = z.object({
  meta: z.object({ buckets: z.array(z.object({ name: z.string(), lo: z.number(), hi: z.number().nullable() })) }),
  statusByBucket: z.record(z.string(), z.record(z.string(), STATUS)),
});
export type StatusTable = z.infer<typeof StatusTableSchema>;

/** Whole texts of any length; a script is scored in its own length bucket, never this one. */
const POOLED_BUCKET = "full";

let table: StatusTable | undefined;

const statusTable = (): StatusTable => {
  table ??= StatusTableSchema.parse(JSON.parse(readFileSync(new URL("../doctrine/writing-check.json", import.meta.url), "utf8")));
  return table;
};

/**
 * Replaces the shipped table until called with undefined. A test of the rewrite's mechanics pins the statuses its
 * fixtures assume, so a recalibration of the shipped file does not change which rows they fail.
 */
export function overrideStatusTable(next: StatusTable | undefined): void {
  table = next;
}

/** The length bucket a script of this many spoken words is scored in; undefined under the shortest bucket. */
function scriptBucket(words: number): string | undefined {
  const buckets = statusTable().meta.buckets.filter((bucket) => bucket.name !== POOLED_BUCKET);
  return buckets.find((bucket) => words >= bucket.lo && (bucket.hi === null || words <= bucket.hi))?.name;
}

/**
 * Each row's status in `doctrine/writing-check.json` at a script's own bucket; empty under the shortest bucket, where
 * no row is judged. Keys are register metric names, as the table writes them.
 */
function rowStatusesAt(words: number): ReadonlyMap<string, WritingStatus> {
  const bucket = scriptBucket(words);
  if (bucket === undefined) return new Map();
  return new Map(Object.entries(statusTable().statusByBucket).flatMap(([row, byBucket]) => {
    const status = byBucket[bucket];
    return status === undefined ? [] : [[row, status] as const];
  }));
}

/** Rows that say something about human-ness at this length: a gate or a warning. */
export const humanSignalRowsAt = (words: number): Set<string> =>
  new Set([...rowStatusesAt(words)].filter(([, status]) => status === "gate" || status === "warning").map(([row]) => row));

/** Rows reported against their band but never warned on at this length: report-only or dropped. */
export const reportedOnlyRowsAt = (words: number): Set<string> =>
  new Set([...rowStatusesAt(words)].filter(([, status]) => status === "report-only" || status === "drop").map(([row]) => row));
