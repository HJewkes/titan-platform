import { minutesBetween, stringField, type BrokerEntry } from "./liveness-broker.js";
import { countMisses, type RouteMiss } from "./liveness-routes.js";

/** A seat off the broker for longer than this is dark; a teleport hand-off takes seconds. */
export const DARK_MIN = 5;

const TELEPORT_EVENTS = new Set(["teleport_started", "teleport_completed", "teleport_failed", "teleport_aborted"]);

/** A name deregistered from the broker until it registered again, or until asOf if it never did, without exiting in between. */
export interface DarkGap {
  seat: string;
  from: string;
  to: string | null;
  minutes: number;
  /** A teleport of this name started after its last registration and before the gap closed. */
  teleport: boolean;
  /** Routes to the seat during the gap logged `delivered:false` and dropped. */
  failedRoutes: number;
  /** Routes during the gap that reached other recipients but not the seat. */
  partialRoutes: number;
  /** Routes the broker held or queued in the seat's inbox for delivery when it returned. */
  queuedRoutes: number;
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
  /** A clean `agent_exited` since the last registration: a later one is a resume, not a dark seat. */
  exited: boolean;
}

type ClosedGap = OpenGap & { seat: string; to: string | null; closeLine?: number };

/** Gaps longer than DARK_MIN, skipping a clean exit and later resume; one still open at asOf counts only if a route missed the seat in it. */
export function darkGaps(entries: readonly BrokerEntry[], misses: readonly RouteMiss[], asOf: string): DarkGap[] {
  return gapsByLifecycle(entries, asOf)
    .filter((gap) => minutesBetween(gap.from, gap.to ?? asOf) > DARK_MIN)
    .map((gap) => toDarkGap(gap, misses, asOf))
    .filter((gap) => gap.to !== null || gap.failedRoutes + gap.partialRoutes + gap.queuedRoutes > 0)
    .sort((a, b) => a.from.localeCompare(b.from) || a.seat.localeCompare(b.seat));
}

/** Every deregistered-to-registered gap per seat, dropping one where the agent exited cleanly without a teleport. */
function gapsByLifecycle(entries: readonly BrokerEntry[], asOf: string): ClosedGap[] {
  const states = new Map<string, SeatState>();
  const gaps: ClosedGap[] = [];
  const keep = (state: SeatState, gap: ClosedGap) => {
    if (!state.exited || gap.teleportLines.length > 0) gaps.push(gap);
  };
  for (const entry of entries) {
    const seat = stringField(entry, "name");
    if (seat === null || entry.ts >= asOf) continue;
    const state = states.get(seat) ?? { open: null, teleportLines: [], exited: false };
    states.set(seat, state);
    step(state, entry, (gap) => keep(state, { ...gap, seat, to: entry.ts, closeLine: entry.line }));
  }
  for (const [seat, state] of states) if (state.open) keep(state, { ...state.open, seat, to: null });
  return gaps;
}

function step(state: SeatState, entry: BrokerEntry, close: (gap: OpenGap) => void): void {
  if (entry.event === "agent_exited") {
    state.exited ||= exitedCleanly(entry);
  } else if (TELEPORT_EVENTS.has(entry.event)) {
    state.teleportLines.push(entry.line);
    state.open?.teleportLines.push(entry.line);
  } else if (entry.event === "deregistered" && !state.open) {
    state.open = { from: entry.ts, lines: [entry.line], teleportLines: [...state.teleportLines] };
  } else if (entry.event === "registered") {
    if (state.open) close(state.open);
    state.open = null;
    state.teleportLines = [];
    state.exited = false;
  }
}

/** Code 0 and not inferred, as agent-chat's exitedCleanly reads it; a crash or an inferred exit leaves the seat dark. */
function exitedCleanly(entry: BrokerEntry): boolean {
  return entry.fields.code === 0 && entry.fields.inferred !== true;
}

function toDarkGap(gap: ClosedGap, misses: readonly RouteMiss[], asOf: string): DarkGap {
  const end = gap.to ?? asOf;
  const missed = misses.filter((m) => m.recipient === gap.seat && m.at >= gap.from && m.at < end);
  const counts = countMisses(missed);
  return {
    seat: gap.seat,
    from: gap.from,
    to: gap.to,
    minutes: minutesBetween(gap.from, end),
    teleport: gap.teleportLines.length > 0,
    failedRoutes: counts.failed,
    partialRoutes: counts.partial,
    queuedRoutes: counts.queued,
    lines: [...gap.lines, ...(gap.closeLine === undefined ? [] : [gap.closeLine]), ...gap.teleportLines],
    routeLines: missed.map((m) => m.line),
  };
}
