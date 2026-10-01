import { stringField, type BrokerEntry } from "./liveness-broker.js";

/** An `agent_spawned` row of agent-chat's events table: the agent id and the profile it ran under. */
export interface SpawnRecord {
  eventId: number;
  agentId: string;
  name: string;
  profile: string | null;
}

/** An agent the broker saw exit without reporting to its spawner. */
export interface UnreportedExit {
  at: string;
  line: number;
  agentId: string;
  name: string;
  spawner: string;
  lastAction: string;
  /** The `agent_spawned` row the profile came from, or null when none matched the agent id. */
  spawnEventId: number | null;
}

export interface UnreportedExitRow {
  profile: string;
  count: number;
  exits: UnreportedExit[];
}

export const UNKNOWN_PROFILE = "unknown";

/** Broker `unreported-exit` lines grouped by the profile the agent was spawned with, most first. */
export function unreportedExitRows(entries: readonly BrokerEntry[], spawns: readonly SpawnRecord[]): UnreportedExitRow[] {
  const byAgent = new Map(spawns.map((s) => [s.agentId, s]));
  const rows = new Map<string, UnreportedExit[]>();
  for (const entry of entries.filter((e) => e.event === "unreported-exit")) {
    const agentId = stringField(entry, "agentId") ?? "";
    const spawn = byAgent.get(agentId);
    const profile = spawn?.profile ?? UNKNOWN_PROFILE;
    const exit = {
      at: entry.ts,
      line: entry.line,
      agentId,
      name: stringField(entry, "name") ?? spawn?.name ?? "",
      spawner: stringField(entry, "spawner") ?? "",
      lastAction: stringField(entry, "lastAction") ?? "",
      spawnEventId: spawn?.eventId ?? null,
    };
    rows.set(profile, [...(rows.get(profile) ?? []), exit]);
  }
  return [...rows.entries()].map(([profile, exits]) => ({ profile, count: exits.length, exits })).sort((a, b) => b.count - a.count || a.profile.localeCompare(b.profile));
}
