import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ShadowRow } from "./row.js";

/** `<dir>/<UTC YYYY-MM-DD>.jsonl` for the wake's instant, so one wake never splits across two day files. */
function shadowDayFile(dir: string, wakeAt: Date): string {
  return join(dir, `${wakeAt.toISOString().slice(0, 10)}.jsonl`);
}

/** Appends in one write, so a reader never sees half a wake; returns the file written. */
export function appendShadowRows(dir: string, wakeAt: Date, rows: readonly ShadowRow[]): string {
  const file = shadowDayFile(dir, wakeAt);
  mkdirSync(dir, { recursive: true });
  appendFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  return file;
}
