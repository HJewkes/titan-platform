import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SeatLine } from "./model.js";

interface DispatchRow {
  ts?: unknown;
  outcome?: unknown;
  usd_est?: unknown;
}

function parseRow(line: string): DispatchRow | undefined {
  try {
    return JSON.parse(line) as DispatchRow;
  } catch {
    return undefined;
  }
}

/** Spawns (`dispatched` rows) and estimated dollars (priced on the retire row) in the window from one seat's `dispatch.jsonl`; a bad line is skipped, not fatal. */
export function seatCost(seat: string, jsonl: string, since: Date): SeatLine {
  let dispatches = 0;
  let usd = 0;
  for (const line of jsonl.split("\n")) {
    const row = line.trim() === "" ? undefined : parseRow(line);
    if (typeof row?.ts !== "string" || Date.parse(row.ts) < since.getTime()) continue;
    if (row.outcome === "dispatched") dispatches += 1;
    usd += typeof row.usd_est === "number" ? row.usd_est : 0;
  }
  return { seat, dispatches, usd };
}

export function readSeatCosts(logsDir: string, seats: readonly string[], since: Date): SeatLine[] {
  return seats.map((seat) => {
    const file = join(logsDir, seat, "dispatch.jsonl");
    return seatCost(seat, existsSync(file) ? readFileSync(file, "utf8") : "", since);
  });
}
