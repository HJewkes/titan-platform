import { WatermarkTable, type Db } from "@titan-design/store-sqlite";

/**
 * Where the last run stopped reading each source. Times are kept as epoch milliseconds in the kit's `last_offset`
 * column; ids and rowids as they are. A mark only bounds the dirty set: a row read twice hashes the same and is skipped.
 */
export interface Marks {
  eventsId: number;
  runsMs: number;
  gatesMs: number;
  tasksMtimeMs: number;
  labelsMtimeMs: number;
  prsMs: number;
  requestsMs: number;
}

const SOURCE_KEYS: Readonly<Record<keyof Marks, string>> = {
  eventsId: "events:id",
  runsMs: "factory:workflow_run",
  gatesMs: "factory:hitl_gate",
  tasksMtimeMs: "tasks:mtime",
  labelsMtimeMs: "labels:mtime",
  prsMs: "graph:pr",
  requestsMs: "graph:request",
};

const NAMES = ["eventsId", "runsMs", "gatesMs", "tasksMtimeMs", "labelsMtimeMs", "prsMs", "requestsMs"] as const satisfies readonly (keyof Marks)[];

export function readMarks(db: Db): Marks {
  const table = new WatermarkTable(db);
  const get = (name: keyof Marks) => table.get(SOURCE_KEYS[name])?.lastOffset ?? 0;
  return {
    eventsId: get("eventsId"),
    runsMs: get("runsMs"),
    gatesMs: get("gatesMs"),
    tasksMtimeMs: get("tasksMtimeMs"),
    labelsMtimeMs: get("labelsMtimeMs"),
    prsMs: get("prsMs"),
    requestsMs: get("requestsMs"),
  };
}

/** Advance the marks that moved; returns how many rows that wrote. */
export function writeMarks(db: Db, before: Marks, after: Marks): number {
  const table = new WatermarkTable(db);
  let written = 0;
  for (const name of NAMES) {
    if (after[name] === before[name]) continue;
    table.ensure(SOURCE_KEYS[name]);
    table.advance(SOURCE_KEYS[name], { lastOffset: after[name] });
    written += 1;
  }
  return written;
}

export function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

export function msOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}
