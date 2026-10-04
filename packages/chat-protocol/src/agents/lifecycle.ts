import type { BrokerEvent } from "./types.js";

/** What the event log says about one agent name: its newest spawn row and the lifecycle rows after it. */
export interface AgentRecord {
  name: string;
  agentId: string;
  spawnedBy: string;
  spawnedAt: number;
  adopted: boolean;
  meta: Record<string, string>;
  brief: string;
  lifecycle: "spawning" | "live" | "detached" | "exited" | "failed" | "retired";
  lastEventAt: number;
  exitCostUsd: number | null;
}

const TRANSITIONS: Partial<Record<string, AgentRecord["lifecycle"]>> = {
  agent_attached: "live",
  agent_resumed: "live",
  agent_detached: "detached",
  agent_exited: "exited",
  agent_retired: "retired",
};

/** `/api/history` drops `ref`, so later rows join on the agent's name; retire and resume name it in `target`. */
const subjectOf = (event: BrokerEvent): string =>
  event.kind === "agent_retired" || event.kind === "agent_resumed" ? (event.meta["target"] ?? event.from) : event.from;

/** One record per name that has a spawn row in the window; a respawn replaces the older record. */
export function foldAgentRecords(events: readonly BrokerEvent[]): Map<string, AgentRecord> {
  const records = new Map<string, AgentRecord>();
  for (const event of events) {
    if (event.kind === "agent_spawned") {
      const record = spawnRecord(event);
      if (record) records.set(record.name, record);
      continue;
    }
    const lifecycle = TRANSITIONS[event.kind];
    const record = records.get(subjectOf(event));
    if (!record) continue;
    record.lastEventAt = Math.max(record.lastEventAt, event.at);
    if (lifecycle) applyTransition(record, lifecycle, event);
  }
  return records;
}

function spawnRecord(event: BrokerEvent): AgentRecord | null {
  const name = event.meta["target"] ?? event.meta["name"] ?? "";
  if (name === "") return null;
  return {
    name,
    agentId: event.msgId,
    spawnedBy: event.from,
    spawnedAt: event.at,
    adopted: event.meta["origin"] === "adopted",
    meta: event.meta,
    brief: event.text,
    lifecycle: "spawning",
    lastEventAt: event.at,
    exitCostUsd: null,
  };
}

function applyTransition(record: AgentRecord, lifecycle: AgentRecord["lifecycle"], event: BrokerEvent): void {
  // A retirement is final for that spawn; a late detach row must not revive it.
  if (record.lifecycle === "retired") return;
  record.lifecycle = lifecycle === "exited" && event.meta["failed"] === "true" ? "failed" : lifecycle;
  if (lifecycle !== "exited") return;
  const cost = Number(event.meta["cost_usd"]);
  if (event.meta["cost_usd"] !== undefined && Number.isFinite(cost)) record.exitCostUsd = cost;
}
