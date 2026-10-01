import { minutesBetween } from "./liveness-broker.js";

/** A prompt this old with nothing after it from the agent is a hang, not a pause for the owner. */
export const PROMPT_STALE_MIN = 10;

/** The newest events-table row an actor wrote before asOf. */
export interface LastEventRecord {
  eventId: number;
  at: string;
  actor: string;
  kind: string;
  /** `meta.tool_name` of an approval request. */
  tool: string | null;
  /** A `resolution` row whose `ref` is this request's msg_id, written before asOf. */
  resolutionEventId: number | null;
}

export interface StalePromptRow {
  agent: string;
  at: string;
  ageMin: number;
  tool: string | null;
  eventId: number;
  resolutionEventId: number | null;
}

/** Agents whose last event is an approval request older than PROMPT_STALE_MIN, oldest first. */
export function stalePromptRows(lastEvents: readonly LastEventRecord[], asOf: string): StalePromptRow[] {
  return lastEvents
    .filter((e) => e.kind === "approval_request" && e.at < asOf)
    .map((e) => ({ agent: e.actor, at: e.at, ageMin: minutesBetween(e.at, asOf), tool: e.tool, eventId: e.eventId, resolutionEventId: e.resolutionEventId }))
    .filter((row) => row.ageMin > PROMPT_STALE_MIN)
    .sort((a, b) => b.ageMin - a.ageMin || a.agent.localeCompare(b.agent));
}
