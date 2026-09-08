import type { Migration } from "./migrations.js";
import { cacheBlobTableDdl } from "./tables/cache-blob.js";
import { edgeTableDdl } from "./tables/edge.js";
import { entitySnapTableDdl, entityTableDdl, snapshotTableDdl } from "./tables/entity.js";
import { spanFtsTablesDdl } from "./tables/span-fts.js";
import { watermarkTableDdl } from "./tables/watermark.js";

/** Which kit tables a store wants, by name override or `true` for the default name. */
export interface KitSelection {
  snapshot?: string | true;
  entitySnap?: string | true;
  entity?: string | true;
  edge?: string | true;
  cacheBlob?: string | true;
  spanFts?: string | true;
  watermark?: string | true;
}

type Factory = (options: { name?: string }) => string;

const FACTORIES: [keyof KitSelection, Factory][] = [
  ["snapshot", snapshotTableDdl],
  ["entitySnap", entitySnapTableDdl],
  ["entity", entityTableDdl],
  ["edge", edgeTableDdl],
  ["cacheBlob", cacheBlobTableDdl],
  ["spanFts", spanFtsTablesDdl],
  ["watermark", watermarkTableDdl],
];

/** The DDL for a selection of kit tables, in dependency-safe order. Every statement is `IF NOT EXISTS`. */
export function kitDdl(selection: KitSelection): string {
  return FACTORIES.filter(([key]) => selection[key] !== undefined)
    .map(([key, factory]) => factory(selection[key] === true ? {} : { name: selection[key] as string }))
    .join("\n");
}

/** A migration that installs the selected kit tables, for use as a store's version 1. */
export function kitMigration(version: number, selection: KitSelection, name = "kit tables"): Migration {
  return { version, name, up: (db) => db.exec(kitDdl(selection)) };
}
