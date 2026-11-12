import { existsSync } from "node:fs";
import { openDatabase, type Db } from "@titan-design/store-sqlite";

/** The stores the job reads. Each is opened read-only; a missing one reads as not measured, never as zero. */
const SOURCES = ["events", "factory", "shepherd-per-run", "graph", "tasks", "labels"] as const;
export type SourceName = (typeof SOURCES)[number];

/** A store opened read-only, or null when the file is absent. Nothing is written, not even a WAL pragma. */
export function openReadOnly(file: string): Db | null {
  if (!existsSync(file)) return null;
  return openDatabase(file, { readonly: true, foreignKeys: false });
}
