import { z } from "zod";
import type { HandoffRecord } from "./events-db.js";
import { stringField, type BrokerEntry } from "./liveness-broker.js";

/** The broker logs this once a teleport's successor holds the name; a started, failed or aborted teleport ends nothing. */
export const TELEPORT_COMPLETED_EVENT = "teleport_completed";
const SPAWNED_EVENT = "agent_spawned";
const EXITED_EVENT = "agent_exited";

export type GenerationEnd = "handoff" | "teleport" | "exit" | "open";

/** One agent process that held the seat's name, from its start to the record that ended it. */
export interface SeatGeneration {
  /** 1-based position among the generations returned. */
  generation: number;
  agentId: string;
  agentName: string;
  /** Graph sessions the agent ran as, one per resume; empty when the graph has none, so the generation still shows. */
  sessionIds: string[];
  /** Null when no spawn line or predecessor handoff records it, e.g. before the broker log rotated. */
  start: string | null;
  end: string | null;
  endedBy: GenerationEnd;
}

export interface SeatGenerationsInput {
  handoffs: readonly HandoffRecord[];
  broker: readonly BrokerEntry[];
  /** Agent id to the graph sessions it ran as, as `readAgentSessions` returns it. */
  agentSessions: ReadonlyMap<string, readonly string[]>;
  seat: string;
  /** Drop generations that ended before this ISO time; the one running at it is kept. */
  since?: string;
}

export const seatGenerationsSchema = z.array(
  z.object({
    generation: z.number().int().positive(),
    agentId: z.string(),
    agentName: z.string(),
    sessionIds: z.array(z.string()),
    start: z.string().nullable(),
    end: z.string().nullable(),
    endedBy: z.enum(["handoff", "teleport", "exit", "open"]),
  }),
);

interface Transition {
  at: string;
  to: string | null;
  endedBy: "handoff" | "teleport";
}

/** The seat's generations in start order: committed handoffs, completed teleports and exits end one; spawns and handoffs start one. */
export function seatGenerations(input: SeatGenerationsInput): SeatGeneration[] {
  const { seat, since } = input;
  const transitions = seatTransitions(input.handoffs, input.broker, seat);
  const spawns = brokerTimes(input.broker, SPAWNED_EVENT, seat, "first");
  const exits = brokerTimes(input.broker, EXITED_EVENT, seat, "last");
  const starts = new Map(spawns);
  for (const t of transitions.values()) if (t.to) starts.set(t.to, t.at);
  const ids = new Set([...spawns.keys(), ...exits.keys(), ...transitions.keys(), ...starts.keys()]);
  const generations = [...ids].map((agentId) => {
    const transition = transitions.get(agentId);
    const exit = exits.get(agentId) ?? null;
    const end = transition?.at ?? exit;
    const endedBy: GenerationEnd = transition?.endedBy ?? (exit ? "exit" : "open");
    return { agentId, agentName: seat, sessionIds: [...(input.agentSessions.get(agentId) ?? [])], start: starts.get(agentId) ?? null, end, endedBy };
  });
  return generations
    .filter((g) => !since || g.end === null || Date.parse(g.end) >= Date.parse(since))
    .sort((a, b) => timeOrder(a.start, b.start, -1) || timeOrder(a.end, b.end, 1))
    .map((g, i) => ({ generation: i + 1, ...g }));
}

/** Outgoing agent id to how it handed over; a handoff row outranks the teleport line for the same handover, and a later row an earlier one. */
function seatTransitions(handoffs: readonly HandoffRecord[], broker: readonly BrokerEntry[], seat: string): Map<string, Transition> {
  const transitions = new Map<string, Transition>();
  for (const entry of broker) {
    const from = stringField(entry, "from");
    if (entry.event === TELEPORT_COMPLETED_EVENT && stringField(entry, "name") === seat && from) transitions.set(from, { at: entry.ts, to: stringField(entry, "to"), endedBy: "teleport" });
  }
  const committed = handoffs.filter((h) => h.seat === seat && h.committed).sort((a, b) => a.eventId - b.eventId);
  for (const h of committed) transitions.set(h.predecessorId, { at: h.at, to: h.successorId, endedBy: "handoff" });
  return transitions;
}

function brokerTimes(broker: readonly BrokerEntry[], event: string, seat: string, keep: "first" | "last"): Map<string, string> {
  const times = new Map<string, string>();
  for (const entry of broker) {
    const agentId = stringField(entry, "agentId");
    if (entry.event !== event || stringField(entry, "name") !== seat || !agentId) continue;
    if (keep === "last" || !times.has(agentId)) times.set(agentId, entry.ts);
  }
  return times;
}

/** Earliest first; `nullSide` -1 puts an unknown start before any known one, 1 an open end after any closed one. */
function timeOrder(a: string | null, b: string | null, nullSide: -1 | 1): number {
  if (a === b) return 0;
  if (a === null) return nullSide;
  if (b === null) return -nullSide;
  return Date.parse(a) - Date.parse(b);
}
