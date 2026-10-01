import { minutesBetween, stringField, type BrokerEntry } from "./liveness-broker.js";
import type { RouteMiss } from "./liveness-routes.js";

/** A seat off the broker for longer than this is dark; a teleport hand-off takes seconds. */
export const DARK_MIN = 5;

const TELEPORT_EVENTS = new Set(["teleport_started", "teleport_completed", "teleport_failed"]);

/** A name deregistered from the broker until it registered again, or until asOf if it never did. */
export interface DarkGap {
  seat: string;
  from: string;
  to: string | null;
  minutes: number;
  /** A teleport of this name started after its last registration and before the gap closed. */
  teleport: boolean;
  /** Routes to the seat during the gap logged `delivered:false`. */
  failedRoutes: number;
  /** Routes during the gap that reached other recipients but not the seat. */
  partialRoutes: number;
  /** The deregistered and registered lines, then any teleport lines. */
  lines: number[];
  routeLines: number[];
}

interface OpenGap {
  from: string;
  lines: number[];
  teleportLines: number[];
}

interface SeatState {
  open: OpenGap | null;
  teleportLines: number[];
}

/** Gaps longer than DARK_MIN; one still open at asOf counts only if a route missed the seat in it. */
export function darkGaps(entries: readonly BrokerEntry[], misses: readonly RouteMiss[], asOf: string): DarkGap[] {
  const states = new Map<string, SeatState>();
  const closed: (OpenGap & { seat: string; to: string | null; closeLine?: number })[] = [];
  for (const entry of entries) {
    const seat = stringField(entry, "name");
    if (seat === null || entry.ts >= asOf) continue;
    const state = states.get(seat) ?? { open: null, teleportLines: [] };
    states.set(seat, state);
    step(state, entry, (gap) => closed.push({ ...gap, seat, to: entry.ts, closeLine: entry.line }));
  }
  for (const [seat, state] of states) if (state.open) closed.push({ ...state.open, seat, to: null });
  return closed
    .filter((gap) => minutesBetween(gap.from, gap.to ?? asOf) > DARK_MIN)
    .map((gap) => toDarkGap(gap, misses, asOf))
    .filter((gap) => gap.to !== null || gap.failedRoutes + gap.partialRoutes > 0)
    .sort((a, b) => a.from.localeCompare(b.from) || a.seat.localeCompare(b.seat));
}

function step(state: SeatState, entry: BrokerEntry, close: (gap: OpenGap) => void): void {
  if (TELEPORT_EVENTS.has(entry.event)) {
    state.teleportLines.push(entry.line);
    state.open?.teleportLines.push(entry.line);
  } else if (entry.event === "deregistered" && !state.open) {
    state.open = { from: entry.ts, lines: [entry.line], teleportLines: [...state.teleportLines] };
  } else if (entry.event === "registered") {
    if (state.open) close(state.open);
    state.open = null;
    state.teleportLines = [];
  }
}

function toDarkGap(gap: OpenGap & { seat: string; to: string | null; closeLine?: number }, misses: readonly RouteMiss[], asOf: string): DarkGap {
  const end = gap.to ?? asOf;
  const missed = misses.filter((m) => m.recipient === gap.seat && m.at >= gap.from && m.at < end);
  return {
    seat: gap.seat,
    from: gap.from,
    to: gap.to,
    minutes: minutesBetween(gap.from, end),
    teleport: gap.teleportLines.length > 0,
    failedRoutes: missed.filter((m) => !m.partial).length,
    partialRoutes: missed.filter((m) => m.partial).length,
    lines: [...gap.lines, ...(gap.closeLine === undefined ? [] : [gap.closeLine]), ...gap.teleportLines],
    routeLines: missed.map((m) => m.line),
  };
}
