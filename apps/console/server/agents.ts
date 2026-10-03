import { z } from "zod";
import { agentGraph, agentRosterSnapshot, foldAgentGraph, foldRoster, type SeatPrefix } from "@titan-design/chat-protocol/agents";
import { defineCommand } from "@titan-design/registry";
import { BROKER_HISTORY_LIMIT, type BrokerReader, type BrokerSnapshot } from "./broker.js";

export interface AgentsSource {
  broker: BrokerReader;
  seatPrefixes: readonly SeatPrefix[];
  now?: () => number;
}

/** Both commands fold one broker read; neither writes to the broker. */
export function agentsCommands(source: AgentsSource) {
  const now = source.now ?? Date.now;
  const roster = (snapshot: BrokerSnapshot, at: number) =>
    foldRoster({ ...snapshot, historyLimit: BROKER_HISTORY_LIMIT, now: at, seatPrefixes: source.seatPrefixes });
  return {
    "agents.roster": defineCommand({
      name: "agents.roster",
      description: "Every agent the agent-chat broker knows: live presence, then exited and retired agents from its history",
      args: z.object({}),
      result: agentRosterSnapshot,
      run: async () => roster(await source.broker.read(), now()),
    }),
    "agents.graph": defineCommand({
      name: "agents.graph",
      description: "The agent spawn tree with spawned-by and message edges, counted over the broker's history window",
      args: z.object({}),
      result: agentGraph,
      run: async () => {
        const snapshot = await source.broker.read();
        const at = now();
        return foldAgentGraph({ events: snapshot.events, historyLimit: BROKER_HISTORY_LIMIT, now: at, roster: roster(snapshot, at).agents });
      },
    }),
  };
}
