import { isSeat } from "../shepherd/wake-brief.js";
import type { WatchRow } from "../shepherd/view.js";
import type { AgentSpan } from "./flow.js";
import type { SeatLine } from "./model.js";

/** A merge whose run names no implementer, or one the roster has no row for, so no spawned-by chain can be walked. */
const UNATTRIBUTED = "unattributed";

/** Each name's spawner from its latest roster row; the human and absent spawners are left out. */
function spawnersOf(roster: readonly AgentSpan[]): Map<string, string> {
  const latest = new Map<string, AgentSpan>();
  for (const row of roster) {
    const seen = latest.get(row.name);
    if (seen === undefined || Date.parse(row.startedAt) >= Date.parse(seen.startedAt)) latest.set(row.name, row);
  }
  return new Map([...latest].flatMap(([name, row]) => (isSeat(row.spawnedBy) ? [[name, row.spawnedBy] as const] : [])));
}

/** The top of `name`'s spawned-by chain: the seat the human started, which owns everything spawned beneath it. */
function coordinatorOf(name: string, spawners: ReadonlyMap<string, string>): string {
  const seen = new Set([name]);
  let current = name;
  for (let next = spawners.get(current); next !== undefined && !seen.has(next); next = spawners.get(current)) {
    seen.add(next);
    current = next;
  }
  return current;
}

/**
 * Merges and spawns in the window per coordinator (TP-4626). A merge counts for the coordinator above its run's
 * implementer; a spawn counts for the coordinator above the agent that spawned it. Busiest first.
 */
export function seatLines(merged: readonly WatchRow[], roster: readonly AgentSpan[], since: Date): SeatLine[] {
  const spawners = spawnersOf(roster);
  const onRoster = new Set(roster.map((row) => row.name));
  const seatOf = (implementer: string | null | undefined): string =>
    implementer && onRoster.has(implementer) ? coordinatorOf(implementer, spawners) : UNATTRIBUTED;
  const lines = new Map<string, SeatLine>();
  const line = (seat: string): SeatLine => lines.get(seat) ?? lines.set(seat, { seat, merges: 0, spawns: 0 }).get(seat)!;
  for (const row of merged) line(seatOf(row.implementer)).merges += 1;
  for (const row of roster) {
    if (isSeat(row.spawnedBy) && Date.parse(row.startedAt) >= since.getTime()) line(coordinatorOf(row.spawnedBy, spawners)).spawns += 1;
  }
  return [...lines.values()].sort((a, b) => b.merges - a.merges || b.spawns - a.spawns || a.seat.localeCompare(b.seat));
}
