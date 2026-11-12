import { rmSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { EXIT } from "@titan-design/registry";
import {
  DEFAULT_THRESHOLDS,
  SCORECARD_MIGRATIONS,
  clearDerivedRows,
  isoWeek,
  phaseWeeks,
  readPhaseWeeks,
  readTaskRows,
  readWeekRows,
  recordRun,
  upsertPhaseWeeks,
  upsertTaskRows,
  upsertWeekRows,
  weekRows,
  type WeekRow,
} from "@titan-design/session-analytics";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { EXIT_LOCKED, tryLock } from "../graph-refresh.js";
import { dirtySet } from "./dirty.js";
import { freezeWeeks, type FreezeResult } from "./freeze.js";
import { buildIndexes, closeSources, notMeasured, openSources, rowSources, type RowSources, type ScorecardPaths } from "./load.js";
import type { PerRunSource } from "./per-run.js";
import { snapshotPool } from "./pool.js";
import { computeRows } from "./rows.js";
import type { SourceName } from "./sources.js";
import { readMarks, writeMarks } from "./watermarks.js";

/** sysexits' EX_UNAVAILABLE: a store a row needs is missing, so nothing was recomputed and the unit shows failed. */
export const EXIT_NOT_MEASURED = 69;

export interface ScorecardRunOptions {
  paths: ScorecardPaths;
  /** The scorecard's own store, the only one the job writes; `:memory:` for a dry run. */
  storeFile: string;
  /** Where closed weeks are frozen; null writes no files (a dry run). */
  weeksDir: string | null;
  /** Null takes no lock (a dry run, whose store is its own). */
  lockFile: string | null;
  rebuild: boolean;
  now: () => Date;
  perRun: PerRunSource;
  /** Reads the store after a measured pass, before it closes; `reproduce` takes its rows from an in-memory rebuild here. */
  inspect?: (store: Db) => void;
}

export interface ScorecardRunResult {
  mode: "incremental" | "rebuild";
  ok: boolean;
  exitCode: number;
  /** Stores that were absent or did not answer; their facts read as not measured. */
  notMeasured: SourceName[];
  /** Label rows read and lines that did not parse; null when the file is absent. */
  labels: { rows: number; invalid: number } | null;
  dirtyTasks: number;
  taskRowsChanged: number;
  weekRowsChanged: number;
  phaseRowsChanged: number;
  poolRowsWritten: number;
  marksAdvanced: number;
  taskRows: number;
  weekRows: number;
  frozen: string[];
  drift: string[];
  ms: number;
}

interface Changes {
  dirtyTasks: number;
  taskRowsChanged: number;
  weekRowsChanged: number;
  phaseRowsChanged: number;
  poolRowsWritten: number;
  marksAdvanced: number;
  freeze: FreezeResult;
}

function cellId(row: WeekRow): string {
  return `${row.isoWeek}\u0000${row.dimension}\u0000${row.key}`;
}

/** Write only the cells whose figures moved, so a run over unchanged inputs writes nothing. */
function syncWeekRows(store: Db, cells: readonly WeekRow[], computedAt: string): number {
  const stored = new Map(readWeekRows(store).map((r) => [cellId(r), r]));
  const changed = cells.filter((cell) => !isDeepStrictEqual(stored.get(cellId(cell)), cell));
  upsertWeekRows(store, changed, computedAt);
  return changed.length;
}

function computeTaskRows(store: Db, s: RowSources, options: ScorecardRunOptions, computedAt: string): Pick<Changes, "dirtyTasks" | "taskRowsChanged" | "marksAdvanced"> {
  const before = readMarks(store);
  const idx = buildIndexes(s);
  const dirty = dirtySet(s, idx, before, options.rebuild);
  const rows = computeRows(store, s, idx, dirty.keys);
  const taskRowsChanged = upsertTaskRows(store, rows, computedAt);
  return { dirtyTasks: dirty.keys.size, taskRowsChanged, marksAdvanced: writeMarks(store, before, dirty.marks) };
}

const NO_FREEZE: FreezeResult = { frozen: [], drift: [], filesWritten: 0 };

function computeAll(store: Db, s: RowSources, options: ScorecardRunOptions): Changes {
  const now = options.now();
  const computedAt = now.toISOString();
  const week = isoWeek(computedAt);
  if (options.rebuild) clearDerivedRows(store);
  const poolRowsWritten = snapshotPool(store, week, s.tasks, s.labels, options.paths.initiativesRoot);
  const tasks = computeTaskRows(store, s, options, computedAt);
  const cells = weekRows(readTaskRows(store), DEFAULT_THRESHOLDS);
  const weekRowsChanged = syncWeekRows(store, cells, computedAt);
  const phaseRowsChanged = upsertPhaseWeeks(store, phaseWeeks([...s.perRun.values()]), computedAt);
  const freeze = options.weeksDir === null ? NO_FREEZE : freezeWeeks(options.weeksDir, cells, readPhaseWeeks(store), week);
  return { ...tasks, weekRowsChanged, phaseRowsChanged, poolRowsWritten, freeze };
}

function openStore(file: string): Db {
  const db = openDatabase(file);
  runMigrations(db, SCORECARD_MIGRATIONS);
  return db;
}

function changedCount(c: Changes): number {
  return c.taskRowsChanged + c.weekRowsChanged + c.phaseRowsChanged + c.poolRowsWritten + c.freeze.filesWritten;
}

const NOTHING: Changes = { dirtyTasks: 0, taskRowsChanged: 0, weekRowsChanged: 0, phaseRowsChanged: 0, poolRowsWritten: 0, marksAdvanced: 0, freeze: NO_FREEZE };

async function runLocked(options: ScorecardRunOptions): Promise<ScorecardRunResult> {
  const startedAt = options.now();
  const sources = await openSources(options.paths, options.perRun);
  const store = openStore(options.storeFile);
  try {
    const s = rowSources(sources);
    const changes = s === null ? NOTHING : store.transaction(() => computeAll(store, s, options))();
    if (s !== null) options.inspect?.(store);
    const ms = Math.max(0, options.now().getTime() - startedAt.getTime());
    const mode = options.rebuild ? "rebuild" : "incremental";
    recordRun(store, { startedAt: startedAt.toISOString(), ms, rowsChanged: changedCount(changes), mode, ok: s !== null });
    const labels = sources.labels === null ? null : { rows: sources.labels.rows, invalid: sources.labels.invalid };
    return resultOf(store, changes, { mode, ok: s !== null, notMeasured: notMeasured(sources), labels, ms });
  } finally {
    store.close();
    closeSources(sources);
  }
}

function resultOf(store: Db, c: Changes, head: Pick<ScorecardRunResult, "mode" | "ok" | "notMeasured" | "labels" | "ms">): ScorecardRunResult {
  const counts = { taskRows: readTaskRows(store).length, weekRows: readWeekRows(store).length };
  const { freeze, ...rest } = c;
  return { ...head, exitCode: head.ok ? EXIT.OK : EXIT_NOT_MEASURED, ...rest, ...counts, frozen: freeze.frozen, drift: freeze.drift };
}

/**
 * One pass of the ticket scorecard: read every store read-only, recompute the dirty tasks' rows and the weekly cells,
 * snapshot the week's pool on its first run, freeze closed weeks, and log the run. With a store missing that a row
 * needs, nothing is recomputed: rows over it would read its facts as zero. Exit 75 when another run holds the lock.
 */
export async function runTicketScorecard(options: ScorecardRunOptions): Promise<ScorecardRunResult | { exitCode: typeof EXIT_LOCKED; locked: true }> {
  if (options.lockFile === null) return runLocked(options);
  if (tryLock(options.lockFile) !== "acquired") return { exitCode: EXIT_LOCKED, locked: true };
  try {
    return await runLocked(options);
  } finally {
    rmSync(options.lockFile, { force: true });
  }
}
