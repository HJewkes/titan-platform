import type { Db, Migration } from "@titan-design/store-sqlite";
import { factRule } from "../../registry/pin-classes.js";
import type { ShadowEvent, ShadowSink } from "../shadow.js";
import type { Verdict } from "../validity.js";

const KINDS = ["verdict", "shadow-error", "call-site-orphan", "budget-exceeded", "entry-end", "not-after-skip", "advisory", "compare"];

const SHADOW_LOG_DDL = `
  CREATE TABLE factory_shadow_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    at             TEXT NOT NULL,
    kind           TEXT NOT NULL CHECK (kind IN (${KINDS.map((kind) => `'${kind}'`).join(", ")})),
    family         TEXT,
    run_id         TEXT NOT NULL,
    memo_key       TEXT,
    item           TEXT,
    step           TEXT,
    fact           TEXT,
    class          TEXT,
    cause          TEXT,
    material_valid INTEGER CHECK (material_valid IN (0, 1)),
    full_valid     INTEGER CHECK (full_valid IN (0, 1)),
    drift          TEXT,
    marker_id      INTEGER,
    detail         TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX factory_shadow_log_at ON factory_shadow_log (at, id);
  CREATE UNIQUE INDEX factory_shadow_log_orphan ON factory_shadow_log (run_id, marker_id) WHERE kind = 'call-site-orphan';
  CREATE UNIQUE INDEX factory_shadow_log_compare ON factory_shadow_log (run_id, memo_key, kind) WHERE kind = 'compare';
  CREATE TRIGGER factory_shadow_log_no_update BEFORE UPDATE ON factory_shadow_log BEGIN SELECT RAISE(ABORT, 'append-only'); END;
  CREATE TRIGGER factory_shadow_log_no_delete BEFORE DELETE ON factory_shadow_log BEGIN SELECT RAISE(ABORT, 'append-only'); END;
  CREATE TRIGGER factory_shadow_log_no_replace BEFORE INSERT ON factory_shadow_log
    FOR EACH ROW WHEN EXISTS (SELECT 1 FROM factory_shadow_log WHERE id = NEW.id)
  BEGIN SELECT RAISE(ABORT, 'append-only'); END;`;

/**
 * TP-3111's SHD-2 disagreement log; 50 follows the marker table at 49. Append-only like `factory_marker`, with no retention
 * before D-M8-09 deletes it. The orphan index makes a call-site orphan durable once per (run, marker) across restarts.
 */
export function shadowLogMigration(version = 50): Migration {
  return { version, name: "factory:shadow_log", up: (db) => db.exec(SHADOW_LOG_DDL) };
}

export interface Validity {
  materialValid: boolean;
  fullValid: boolean;
  drift: string[];
}

/** Material validity is the verdict itself; full validity also needs every input's full output unmoved (R23). */
export function fullAndMaterial(verdict: Verdict): Validity {
  if (verdict.status !== "valid") return { materialValid: false, fullValid: false, drift: [] };
  return { materialValid: true, fullValid: verdict.drift.length === 0, drift: verdict.drift };
}

interface LogFields {
  family: string | null;
  item: string | null;
  validity: Validity | null;
  markerId: number | null;
  detail: Record<string, unknown>;
}

const NO_FIELDS: Omit<LogFields, "family" | "detail"> = { item: null, validity: null, markerId: null };

function verdictFields(event: Extract<ShadowEvent, { kind: "verdict" }>, family: string | null): LogFields {
  const { verdict, wouldFastForward, unreplayable } = event;
  const marker = verdict.status === "valid" ? verdict.marker : undefined;
  const reason = verdict.status === "absent" ? { reason: verdict.reason, reasonDetail: verdict.detail ?? null } : {};
  return { ...NO_FIELDS, family: marker?.pinClass ?? family, validity: fullAndMaterial(verdict), markerId: marker?.id ?? null, detail: { wouldFastForward, unreplayable, ...reason } };
}

function fieldsOf(event: ShadowEvent, family: string | null): LogFields {
  switch (event.kind) {
    case "verdict":
      return verdictFields(event, family);
    case "shadow-error":
      return { ...NO_FIELDS, family, detail: { error: event.error } };
    case "call-site-orphan":
      return { ...NO_FIELDS, family: event.marker.pinClass, item: event.marker.item, markerId: event.marker.id, detail: { callSite: event.callSite, failClosed: event.failClosed } };
    case "budget-exceeded":
    case "entry-end":
      return { ...NO_FIELDS, family, detail: { counters: event.counters } };
    case "not-after-skip":
      return { ...NO_FIELDS, family, detail: { notAfter: event.notAfter } };
    case "advisory":
      return { ...NO_FIELDS, family, detail: {} };
  }
}

const INSERT = `INSERT OR IGNORE INTO factory_shadow_log (at, kind, family, run_id, memo_key, item, step, fact, material_valid, full_valid, drift, marker_id, detail)
  VALUES (@at, @kind, @family, @runId, @memoKey, @item, @step, @fact, @materialValid, @fullValid, @drift, @markerId, @detail)`;

const flag = (value: boolean | undefined): number | null => (value === undefined ? null : Number(value));

/** A sink that persists every shadow event as one row; a re-sent orphan appends nothing. Callers wrap it in `swallow`. */
export function logSink(db: Db, now: () => string): ShadowSink {
  const insert = db.prepare(INSERT);
  return (event) => {
    const fields = fieldsOf(event, factRule(event.fact)?.pinClass ?? null);
    insert.run({
      at: now(),
      kind: event.kind,
      family: fields.family,
      runId: event.runId,
      memoKey: event.memoKey || null,
      item: fields.item,
      step: event.stepId || null,
      fact: event.fact || null,
      materialValid: flag(fields.validity?.materialValid),
      fullValid: flag(fields.validity?.fullValid),
      drift: fields.validity ? JSON.stringify(fields.validity.drift) : null,
      markerId: fields.markerId,
      detail: JSON.stringify(fields.detail),
    });
  };
}

export interface ShadowLogRow {
  id: number;
  at: string;
  kind: string;
  family: string | null;
  runId: string;
  memoKey: string | null;
  item: string | null;
  step: string | null;
  fact: string | null;
  class: string | null;
  cause: string | null;
  materialValid: boolean | null;
  fullValid: boolean | null;
  drift: string[] | null;
  markerId: number | null;
  detail: Record<string, unknown>;
}

interface RawRow extends Omit<ShadowLogRow, "materialValid" | "fullValid" | "drift" | "detail"> {
  materialValid: number | null;
  fullValid: number | null;
  drift: string | null;
  detail: string;
}

const SELECT = `SELECT id, at, kind, family, run_id AS runId, memo_key AS memoKey, item, step, fact, class, cause,
  material_valid AS materialValid, full_valid AS fullValid, drift, marker_id AS markerId, detail
  FROM factory_shadow_log WHERE at >= ? ORDER BY id`;

const bool = (value: number | null): boolean | null => (value === null ? null : value === 1);

/** Every row at or after `sinceIso`, oldest first. */
export function readLog(db: Db, window: { sinceIso: string }): ShadowLogRow[] {
  const rows = db.prepare(SELECT).all(window.sinceIso) as RawRow[];
  return rows.map((row) => ({
    ...row,
    materialValid: bool(row.materialValid),
    fullValid: bool(row.fullValid),
    drift: row.drift === null ? null : (JSON.parse(row.drift) as string[]),
    detail: JSON.parse(row.detail) as Record<string, unknown>,
  }));
}
