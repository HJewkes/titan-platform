import { kitDdl, type Db, type Migration } from "@titan-design/store-sqlite";
import { z } from "zod";
import { RED_FLAGS } from "./red-flags.js";
import type { PoolTask } from "./rule-pick.js";
import type { Provenance, TaskClass, TaskRow } from "./types.js";
import { weekMetricsSchema } from "./week-metrics.js";
import type { WeekRow } from "./week-rows.js";

const INFERRED_PREFIX = "inferred:";

function isProvenance(value: unknown): value is Provenance {
  return value === "recorded" || (typeof value === "string" && value.startsWith(INFERRED_PREFIX));
}

const provenanceSchema = z.record(z.string(), z.custom<Provenance>(isProvenance));

/**
 * The task row's scalar columns, in table order: SQLite column, then `TaskRow` field. Booleans are stored as
 * 0 or 1 and `provenance` as JSON; both are converted at the edge.
 */
const TASK_COLUMNS = [
  ["initiative", "initiative"],
  ["task_id", "taskId"],
  ["first_dispatch_ts", "firstDispatchTs"],
  ["dispatcher", "dispatcher"],
  ["dispatch_rule", "dispatchRule"],
  ["class_at_dispatch", "classAtDispatch"],
  ["source_at_dispatch", "sourceAtDispatch"],
  ["serves_at_dispatch", "servesAtDispatch"],
  ["rank_at_dispatch", "rankAtDispatch"],
  ["age_at_dispatch_h", "ageAtDispatchH"],
  ["rule_rank_pct", "ruleRankPct"],
  ["in_rule_topk", "inRuleTopk"],
  ["merged_at", "mergedAt"],
  ["prs", "prs"],
  ["fix_rounds", "fixRounds"],
  ["review_rounds", "reviewRounds"],
  ["reverted_by", "revertedBy"],
  ["done_reason", "doneReason"],
  ["followups_n", "followupsN"],
  ["followups_est", "followupsEst"],
  ["brief_has_done_when", "briefHasDoneWhen"],
  ["lead_created_done_h", "leadCreatedDoneH"],
  ["lead_dispatch_merge_h", "leadDispatchMergeH"],
  ["usd", "usd"],
  ["usd_link", "usdLink"],
  ["owner_gates", "ownerGates"],
  ["owner_gate_hours", "ownerGateHours"],
  ["dup_prs", "dupPrs"],
  ["inputs_hash", "inputsHash"],
] as const satisfies readonly (readonly [string, keyof TaskRow])[];

const SCORECARD_DDL = `
  CREATE TABLE IF NOT EXISTS task_row (
    ${TASK_COLUMNS.map(([column]) => column).join(",\n    ")},
    provenance_json TEXT NOT NULL,
    computed_at     TEXT NOT NULL,
    PRIMARY KEY (initiative, task_id)
  );
  CREATE TABLE IF NOT EXISTS week_row (
    iso_week       TEXT NOT NULL,
    dimension      TEXT NOT NULL,
    key            TEXT NOT NULL,
    metrics_json   TEXT NOT NULL,
    inferred_share REAL,
    red_flags_json TEXT NOT NULL,
    computed_at    TEXT NOT NULL,
    PRIMARY KEY (iso_week, dimension, key)
  );
  CREATE TABLE IF NOT EXISTS pool_snapshot (
    iso_week   TEXT NOT NULL,
    task_id    TEXT NOT NULL,
    class      TEXT,
    rank       REAL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (iso_week, task_id)
  );
  CREATE TABLE IF NOT EXISTS run (
    started_at   TEXT PRIMARY KEY,
    ms           INTEGER NOT NULL,
    rows_changed INTEGER NOT NULL,
    mode         TEXT NOT NULL CHECK (mode IN ('incremental', 'rebuild')),
    ok           INTEGER NOT NULL
  );`;

/** The scorecard store's own database: the derived tables plus the kit's per-source watermark table. */
export const SCORECARD_MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "ticket-scorecard:tables", up: (db) => db.exec(SCORECARD_DDL + kitDdl({ watermark: true })) },
];

type SqlValue = string | number | null;

function toSql(value: TaskRow[keyof TaskRow]): SqlValue {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" || typeof value === "number" || value === null) return value;
  return JSON.stringify(value);
}

/**
 * Upsert task rows; a row whose `inputsHash` is already stored is skipped. Returns how many rows changed.
 * `computedAt` comes from the caller, so the store reads no clock.
 */
export function upsertTaskRows(db: Db, rows: readonly TaskRow[], computedAt: string): number {
  const columns = TASK_COLUMNS.map(([column]) => column);
  const updates = columns.filter((c) => c !== "initiative" && c !== "task_id").map((c) => `${c} = excluded.${c}`);
  const statement = db.prepare(
    `INSERT INTO task_row (${columns.join(", ")}, provenance_json, computed_at)
     VALUES (${columns.map(() => "?").join(", ")}, ?, ?)
     ON CONFLICT (initiative, task_id) DO UPDATE SET ${updates.join(", ")},
       provenance_json = excluded.provenance_json, computed_at = excluded.computed_at
     WHERE task_row.inputs_hash IS NOT excluded.inputs_hash`,
  );
  let changed = 0;
  db.transaction(() => {
    for (const row of rows) {
      const values = TASK_COLUMNS.map(([, field]) => toSql(row[field]));
      changed += statement.run(...values, JSON.stringify(row.provenance), computedAt).changes;
    }
  })();
  return changed;
}

/** A `task_row` record as SQLite returns it: the TaskRow columns with booleans as 0 or 1. */
type TaskRecord = { [C in (typeof TASK_COLUMNS)[number] as C[0]]: TaskRow[C[1]] extends boolean | null ? 0 | 1 | null : TaskRow[C[1]] } & {
  provenance_json: string;
};

function flag(value: 0 | 1 | null): boolean | null {
  return value === null ? null : value === 1;
}

function dispatchFacts(r: TaskRecord) {
  return {
    initiative: r.initiative,
    taskId: r.task_id,
    firstDispatchTs: r.first_dispatch_ts,
    dispatcher: r.dispatcher,
    dispatchRule: r.dispatch_rule,
    classAtDispatch: r.class_at_dispatch,
    sourceAtDispatch: r.source_at_dispatch,
    servesAtDispatch: r.serves_at_dispatch,
    rankAtDispatch: r.rank_at_dispatch,
    ageAtDispatchH: r.age_at_dispatch_h,
    ruleRankPct: r.rule_rank_pct,
    inRuleTopk: flag(r.in_rule_topk),
  };
}

function outcomeFacts(r: TaskRecord) {
  return {
    mergedAt: r.merged_at,
    prs: r.prs,
    fixRounds: r.fix_rounds,
    reviewRounds: r.review_rounds,
    revertedBy: r.reverted_by,
    doneReason: r.done_reason,
    followupsN: r.followups_n,
    followupsEst: r.followups_est,
    briefHasDoneWhen: flag(r.brief_has_done_when),
    leadCreatedDoneH: r.lead_created_done_h,
    leadDispatchMergeH: r.lead_dispatch_merge_h,
    usd: r.usd,
    usdLink: r.usd_link,
    ownerGates: r.owner_gates,
    ownerGateHours: r.owner_gate_hours,
    dupPrs: r.dup_prs,
  };
}

function fromSql(record: TaskRecord): TaskRow {
  const provenance = provenanceSchema.parse(JSON.parse(record.provenance_json));
  return { ...dispatchFacts(record), ...outcomeFacts(record), provenance, inputsHash: record.inputs_hash };
}

/** Every stored task row, in key order. */
export function readTaskRows(db: Db): TaskRow[] {
  const records = db.prepare<[], TaskRecord>("SELECT * FROM task_row ORDER BY initiative, task_id").all();
  return records.map(fromSql);
}

/** Upsert weekly cells; a rerun over the same task rows rewrites the same contents. */
export function upsertWeekRows(db: Db, rows: readonly WeekRow[], computedAt: string): void {
  const statement = db.prepare(
    `INSERT INTO week_row (iso_week, dimension, key, metrics_json, inferred_share, red_flags_json, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (iso_week, dimension, key) DO UPDATE SET metrics_json = excluded.metrics_json,
       inferred_share = excluded.inferred_share, red_flags_json = excluded.red_flags_json, computed_at = excluded.computed_at`,
  );
  db.transaction(() => {
    for (const row of rows) {
      const metrics = JSON.stringify(row.metrics);
      statement.run(row.isoWeek, row.dimension, row.key, metrics, row.metrics.inferredShare, JSON.stringify(row.redFlags), computedAt);
    }
  })();
}

interface WeekRecord {
  iso_week: string;
  dimension: WeekRow["dimension"];
  key: string;
  metrics_json: string;
  red_flags_json: string;
}

/** Every stored weekly cell, in key order. */
export function readWeekRows(db: Db): WeekRow[] {
  const records = db.prepare<[], WeekRecord>("SELECT * FROM week_row ORDER BY iso_week, dimension, key").all();
  return records.map((r) => ({
    isoWeek: r.iso_week,
    dimension: r.dimension,
    key: r.key,
    metrics: weekMetricsSchema.parse(JSON.parse(r.metrics_json)),
    redFlags: z.array(z.enum(RED_FLAGS)).parse(JSON.parse(r.red_flags_json)),
  }));
}

/** Write a week's rule-ready pool once: a later call for the same week keeps the first snapshot and writes nothing. */
export function writePoolSnapshot(db: Db, isoWeek: string, pool: readonly PoolTask[]): number {
  if (db.prepare("SELECT 1 FROM pool_snapshot WHERE iso_week = ? LIMIT 1").get(isoWeek) !== undefined) return 0;
  const statement = db.prepare("INSERT OR IGNORE INTO pool_snapshot (iso_week, task_id, class, rank, created_at) VALUES (?, ?, ?, ?, ?)");
  let written = 0;
  db.transaction(() => {
    for (const task of pool) written += statement.run(isoWeek, task.taskId, task.class, task.rank, task.createdAt).changes;
  })();
  return written;
}

interface PoolRecord {
  task_id: string;
  class: TaskClass | null;
  rank: number | null;
  created_at: string;
}

export function readPoolSnapshot(db: Db, isoWeek: string): PoolTask[] {
  const records = db.prepare<[string], PoolRecord>("SELECT task_id, class, rank, created_at FROM pool_snapshot WHERE iso_week = ? ORDER BY task_id").all(isoWeek);
  return records.map((r) => ({ taskId: r.task_id, class: r.class, rank: r.rank, createdAt: r.created_at }));
}
