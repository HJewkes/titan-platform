import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { z } from "zod";
import type { Arm, Track } from "./arms.js";

export const JOB_SCHEMA = "titan.bench-job/v1";

export type Outcome = "ok" | "timeout" | "infra" | "contaminated" | "arm-mismatch" | "error";

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface JobRow {
  schema: typeof JOB_SCHEMA;
  track: Track;
  arm: Arm;
  caseId: string;
  caseHash: string;
  block: number;
  stratum: Record<string, string> | null;
  attempt: number;
  sessionId: string;
  transcript: string;
  startedAt: string;
  endedAt: string;
  seconds: number;
  exit: { code: number | null; timedOut: boolean };
  outcome: Outcome;
  tokens: Record<string, TokenCounts> | null;
  listUsd: number | null;
  effortSeen: string[] | null;
  modelSeen: string[] | null;
}

/** Outcomes that may be transient; each earns exactly one more attempt on a later start. */
const RETRIED_ONCE: ReadonlySet<Outcome> = new Set(["infra", "arm-mismatch"]);
const MAX_ATTEMPTS = 2;

/** One write plus fsync per row, so a crash loses at most the row being written. */
export function appendJsonl(path: string, row: unknown): void {
  const fd = openSync(path, "a");
  try {
    writeSync(fd, `${JSON.stringify(row)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** A torn final line (a crash mid-write) is dropped; a bad line anywhere else is corruption and throws. */
export function readJobRows(path: string): JobRow[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  const last = lines.length - 1;
  return lines.flatMap((line, index) => {
    if (line.trim() === "") return [];
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      if (index === last) return [];
      throw new Error(`${path}:${index + 1} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isJobRow(value)) throw new Error(`${path}:${index + 1} is not a ${JOB_SCHEMA} row`);
    return [value];
  });
}

/** The fields resume keys on; a row missing one is from another tool. */
const RowKeys = z.looseObject({ schema: z.literal(JOB_SCHEMA), arm: z.looseObject({ id: z.string() }), caseHash: z.string(), outcome: z.string() });
const isJobRow = (value: unknown): value is JobRow => RowKeys.safeParse(value).success;

/** A key's next attempt number, or null once it is finished; a key with no rows runs as attempt 1. */
export function nextAttempt(rows: readonly JobRow[], armId: string, caseHash: string): number | null {
  const mine = rows.filter((row) => row.arm.id === armId && row.caseHash === caseHash);
  const last = mine.at(-1);
  if (last === undefined) return 1;
  if (!RETRIED_ONCE.has(last.outcome) || mine.length >= MAX_ATTEMPTS) return null;
  return mine.length + 1;
}
