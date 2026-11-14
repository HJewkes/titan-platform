import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Track } from "../arms.js";
import { readJobRows, type JobRow, type Outcome } from "../ledger.js";

/** One (arm, case) of a track: its latest attempt's job joined to that attempt's score. */
export interface Cell {
  arm: string;
  caseId: string;
  caseHash: string;
  block: number;
  stratum: Record<string, string>;
  outcome: Outcome;
  seconds: number;
  listUsd: number;
  tokens: number;
  pilotOnly: boolean;
  result: Record<string, unknown>;
}

export interface RunData {
  track: Track;
  dir: string;
  cells: Cell[];
  /** Every job row, earlier attempts included, because each one was paid for. */
  jobs: JobRow[];
  judgments: Record<string, unknown>[];
}

const ScoreRow = z.looseObject({ arm: z.string(), caseHash: z.string(), attempt: z.number().int(), result: z.record(z.string(), z.unknown()).nullable().optional() });

function jsonLines(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (line.trim() === "") return [];
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const cellKey = (arm: string, caseHash: string, attempt: number): string => `${arm}\u0000${caseHash}\u0000${attempt}`;

function tokenTotal(row: JobRow): number {
  return Object.values(row.tokens ?? {}).reduce((sum, counts) => sum + counts.input + counts.output + counts.cacheRead + counts.cacheWrite5m + counts.cacheWrite1h, 0);
}

function latestJobs(jobs: readonly JobRow[]): JobRow[] {
  const latest = new Map<string, JobRow>();
  for (const row of jobs) {
    const key = `${row.arm.id}\u0000${row.caseHash}`;
    const seen = latest.get(key);
    if (seen === undefined || row.attempt >= seen.attempt) latest.set(key, row);
  }
  return [...latest.values()];
}

function toCell(row: JobRow, result: Record<string, unknown> | undefined): Cell {
  return {
    arm: row.arm.id,
    caseId: row.caseId,
    caseHash: row.caseHash,
    block: row.block,
    stratum: row.stratum ?? {},
    outcome: row.outcome,
    seconds: row.seconds,
    listUsd: row.listUsd ?? 0,
    tokens: tokenTotal(row),
    pilotOnly: row.arm.pilotOnly === true,
    result: result ?? {},
  };
}

/** Reads a run dir's three ledgers; a missing scores or judgments file reads as empty. */
export function loadRun(track: Track, dir: string): RunData {
  const jobs = readJobRows(join(dir, "jobs.jsonl")).filter((row) => row.track === track);
  const scores = new Map<string, Record<string, unknown>>();
  for (const raw of jsonLines(join(dir, "scores.jsonl"))) {
    const row = ScoreRow.safeParse(raw);
    if (row.success) scores.set(cellKey(row.data.arm, row.data.caseHash, row.data.attempt), row.data.result ?? {});
  }
  const cells = latestJobs(jobs).map((row) => toCell(row, scores.get(cellKey(row.arm.id, row.caseHash, row.attempt))));
  return { track, dir, cells, jobs, judgments: jsonLines(join(dir, "judgments.jsonl")).filter(isRecord) };
}
