import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { byRecRowSchema, type ByRecRow } from "@titan-design/owner-queue";

/** One `titan/auto-by-rec@1` row per line, beside the factory database; `shepherd by-rec` and the console log page read it. */
export const BY_REC_LOG = "auto-by-rec.jsonl";

export const byRecLogPath = (stateDir: string): string => join(stateDir, BY_REC_LOG);

function parsedLine(line: string): ByRecRow | undefined {
  try {
    return byRecRowSchema.safeParse(JSON.parse(line)).data;
  } catch {
    return undefined;
  }
}

/** Every well-formed row, oldest first; a missing file is an empty log, and a torn or foreign line is skipped. */
export function readByRecRows(path: string): ByRecRow[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return text.split("\n").flatMap((line) => (line.trim() === "" ? [] : (parsedLine(line) ?? [])));
}

/** Rows resolved at or after `since`, an epoch-ms bound; undefined keeps every row. */
export function rowsSince(rows: readonly ByRecRow[], since: number | undefined): ByRecRow[] {
  return since === undefined ? [...rows] : rows.filter((row) => Date.parse(row.resolvedAt) >= since);
}

/** A subject logs once per mode, so a restart or a later tick never writes, or acts on, the same gate twice. */
export const rowKey = (row: Pick<ByRecRow, "subject" | "mode">): string => `${row.mode}\n${row.subject.id}`;

/** Validates before it writes, so the log never holds a row its readers would drop. */
export function appendByRecRow(path: string, row: ByRecRow): void {
  appendFileSync(path, `${JSON.stringify(byRecRowSchema.parse(row))}\n`);
}
