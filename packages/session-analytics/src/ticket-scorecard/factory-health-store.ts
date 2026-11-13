import { isDeepStrictEqual } from "node:util";
import type { Db, Migration } from "@titan-design/store-sqlite";
import { factoryHealthSchema, type FactoryHealth } from "./factory-health.js";

const FACTORY_HEALTH_DDL = `
  CREATE TABLE IF NOT EXISTS factory_health_week (
    iso_week    TEXT PRIMARY KEY,
    health_json TEXT NOT NULL,
    computed_at TEXT NOT NULL
  );`;

/** The "Factory health" group per week (TP-5446 S18). */
export const FACTORY_HEALTH_MIGRATION: Migration = { version: 3, name: "ticket-scorecard:factory_health_week", up: (db) => db.exec(FACTORY_HEALTH_DDL) };

/** Every stored week of the group, oldest first. */
export function readFactoryHealth(db: Db): FactoryHealth[] {
  const records = db.prepare<[], { health_json: string }>("SELECT health_json FROM factory_health_week ORDER BY iso_week").all();
  return records.map((r) => factoryHealthSchema.parse(JSON.parse(r.health_json)));
}

/** Upsert the weeks whose figures moved; returns how many were written, so a rerun over unchanged rows writes none. */
export function upsertFactoryHealth(db: Db, weeks: readonly FactoryHealth[], computedAt: string): number {
  const stored = new Map(readFactoryHealth(db).map((w) => [w.isoWeek, w]));
  const changed = weeks.filter((w) => !isDeepStrictEqual(stored.get(w.isoWeek), w));
  const statement = db.prepare(
    `INSERT INTO factory_health_week (iso_week, health_json, computed_at) VALUES (?, ?, ?)
     ON CONFLICT (iso_week) DO UPDATE SET health_json = excluded.health_json, computed_at = excluded.computed_at`,
  );
  db.transaction(() => {
    for (const week of changed) statement.run(week.isoWeek, JSON.stringify(week), computedAt);
  })();
  return changed.length;
}
