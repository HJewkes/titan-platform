import type { Db, Migration } from "@titan-design/store-sqlite";
import type { PhaseWeek } from "./phase-weeks.js";

const PHASE_WEEK_DDL = `
  CREATE TABLE IF NOT EXISTS phase_week (
    iso_week       TEXT NOT NULL,
    repo           TEXT NOT NULL,
    stage          TEXT NOT NULL,
    runs           INTEGER NOT NULL,
    median_minutes REAL NOT NULL,
    p90_minutes    REAL NOT NULL,
    computed_at    TEXT NOT NULL,
    PRIMARY KEY (iso_week, repo, stage)
  );`;

/** Shepherd phase medians per week (TP-467), added in slice S2. */
export const PHASE_WEEK_MIGRATION: Migration = { version: 2, name: "ticket-scorecard:phase_week", up: (db) => db.exec(PHASE_WEEK_DDL) };

/** Upsert phase cells; a cell whose figures are already stored is left alone. Returns how many cells changed. */
export function upsertPhaseWeeks(db: Db, rows: readonly PhaseWeek[], computedAt: string): number {
  const statement = db.prepare(
    `INSERT INTO phase_week (iso_week, repo, stage, runs, median_minutes, p90_minutes, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (iso_week, repo, stage) DO UPDATE SET runs = excluded.runs, median_minutes = excluded.median_minutes,
       p90_minutes = excluded.p90_minutes, computed_at = excluded.computed_at
     WHERE phase_week.runs IS NOT excluded.runs OR phase_week.median_minutes IS NOT excluded.median_minutes
       OR phase_week.p90_minutes IS NOT excluded.p90_minutes`,
  );
  let changed = 0;
  db.transaction(() => {
    for (const r of rows) changed += statement.run(r.isoWeek, r.repo, r.stage, r.runs, r.medianMinutes, r.p90Minutes, computedAt).changes;
  })();
  return changed;
}

/** One pass of the scorecard job, as the `run` table logs it. */
export interface ScorecardRunLog {
  startedAt: string;
  ms: number;
  rowsChanged: number;
  mode: "incremental" | "rebuild";
  ok: boolean;
}

export function recordRun(db: Db, run: ScorecardRunLog): void {
  db.prepare("INSERT INTO run (started_at, ms, rows_changed, mode, ok) VALUES (?, ?, ?, ?, ?)").run(run.startedAt, run.ms, run.rowsChanged, run.mode, run.ok ? 1 : 0);
}

interface PhaseRecord {
  iso_week: string;
  repo: string;
  stage: string;
  runs: number;
  median_minutes: number;
  p90_minutes: number;
}

/** Every stored phase cell, in key order. */
export function readPhaseWeeks(db: Db): PhaseWeek[] {
  const records = db.prepare<[], PhaseRecord>("SELECT * FROM phase_week ORDER BY iso_week, repo, stage").all();
  return records.map((r) => ({ isoWeek: r.iso_week, repo: r.repo, stage: r.stage, runs: r.runs, medianMinutes: r.median_minutes, p90Minutes: r.p90_minutes }));
}
