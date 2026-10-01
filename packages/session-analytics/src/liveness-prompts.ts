import { minutesBetween, stringField, type BrokerEntry } from "./liveness-broker.js";

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
  /** An `agent_exited` or `agent_retired` row for this actor after the request and before asOf. */
  endEventId: number | null;
}

export interface StalePromptRow {
  agent: string;
  at: string;
  ageMin: number;
  tool: string | null;
  eventId: number;
  resolutionEventId: number | null;
}

/** Live agents whose last event is an approval request older than PROMPT_STALE_MIN, oldest first; resolved ones included. */
export function stalePromptRows(lastEvents: readonly LastEventRecord[], broker: readonly BrokerEntry[], asOf: string): StalePromptRow[] {
  const gone = goneSinceRestart(broker, asOf);
  return lastEvents
    .filter((e) => e.kind === "approval_request" && e.at < asOf && e.endEventId === null && !gone(e))
    .map((e) => ({ agent: e.actor, at: e.at, ageMin: minutesBetween(e.at, asOf), tool: e.tool, eventId: e.eventId, resolutionEventId: e.resolutionEventId }))
    .filter((row) => row.ageMin > PROMPT_STALE_MIN)
    .sort((a, b) => b.ageMin - a.ageMin || a.agent.localeCompare(b.agent));
}

/** An agent that prompted before the broker's last restart and never registered after it is gone, not hung. */
function goneSinceRestart(broker: readonly BrokerEntry[], asOf: string): (e: LastEventRecord) => boolean {
  const before = broker.filter((e) => e.ts < asOf);
  const restart = before.filter((e) => e.event === "broker_started").at(-1)?.ts;
  if (restart === undefined) return () => false;
  const live = new Set(before.filter((e) => e.event === "registered" && e.ts >= restart).map((e) => stringField(e, "name")));
  return (e) => e.at < restart && !live.has(e.actor);
}
