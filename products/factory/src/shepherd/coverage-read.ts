import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "@titan-design/store-sqlite";
import { WorkflowRunStore, type WorkflowRun, type WorkflowStatus } from "@titan-design/workflow";
import { SHEPHERD_WORKFLOW } from "./commands.js";
import { coverage, mergedRows, type CoverageReport, type CoverageWindow, type LedgerRegistration, type MergedRow } from "./coverage.js";
import { ShepherdStore } from "./store.js";

const ALL_STATUSES: WorkflowStatus[] = ["running", "paused", "cancelling", "recovery_required", "completed", "failed", "cancelled"];

/** Every seat's `<logsDir>/<seat>/dispatch.jsonl`; a seat with no log reads as no rows. */
function readMergedRows(logsDir: string, seats: readonly string[]): { rows: MergedRow[]; skipped: number } {
  const parsed = seats.map((seat) => {
    const file = join(logsDir, seat, "dispatch.jsonl");
    return mergedRows(seat, existsSync(file) ? readFileSync(file, "utf8") : "");
  });
  return { rows: parsed.flatMap((p) => p.rows), skipped: parsed.reduce((sum, p) => sum + p.skipped, 0) };
}

/** Opened read-only, so a running serve is never disturbed; throws when the store cannot be opened. */
function readLedger(dbPath: string): { registrations: LedgerRegistration[]; runs: WorkflowRun[] } {
  const db = openDatabase(dbPath, { readonly: true });
  try {
    const runs = new WorkflowRunStore(db).listByStatus(ALL_STATUSES).filter((run) => run.workflowName === SHEPHERD_WORKFLOW);
    return { registrations: new ShepherdStore(db).all(), runs };
  } finally {
    db.close();
  }
}

interface CoverageSources {
  dbPath: string;
  logsDir: string;
  /** Seat name to the `owner/name` remotes it owns, from the seat book. */
  remotes: Readonly<Record<string, readonly string[]>>;
  window: CoverageWindow;
}

export function readCoverage(sources: CoverageSources): CoverageReport {
  const logs = readMergedRows(sources.logsDir, Object.keys(sources.remotes));
  return coverage({ ...logs, ...readLedger(sources.dbPath), remotes: sources.remotes, window: sources.window });
}
