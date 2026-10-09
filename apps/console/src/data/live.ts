import type { CommandName } from "@titan-design/rpc-client";
import type { ConsoleCommands } from "../../server/commands.js";
import type { RelaySource } from "../../server/events-relay.js";
import { useInvalidateOn } from "./rpc.js";

/** The reads each relayed source can change; a broker message never refetches active-work's reads. */
export const RELAY_INVALIDATES = {
  "active-work": ["work.portfolio", "work.initiative", "work.tasks", "work.task", "graph.ego"],
  "agent-chat": ["agents.roster", "agents.graph", "agents.messages", "agents.queue"],
} as const satisfies Record<RelaySource, readonly CommandName<ConsoleCommands>[]>;

/** Mounted once by the shell: every open page refetches its reads when the daemon relays a matching upstream event. */
export function useRelayInvalidation(): void {
  useInvalidateOn({ events: ["active-work"], commands: RELAY_INVALIDATES["active-work"] });
  useInvalidateOn({ events: ["agent-chat"], commands: RELAY_INVALIDATES["agent-chat"] });
}
