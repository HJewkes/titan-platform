import { DEFAULT_PARK_TIMEOUT_MS, parkAgent } from "@titan-design/agent-dispatch";
import { configPath, loadConfig } from "./config.js";
import { AGENT_CALL_TIMEOUT_MS, agentChatAgents } from "./shepherd/agents.js";
import { agentChatCleanupAgents } from "./shepherd/cleanup-ports.js";
import type { FixerRetirePorts } from "./shepherd/fixer-retire.js";
import type { MainWatchPorts } from "./shepherd/main-watch.js";

/** A red event goes out over agent-chat, so no configured `agentChatBin` means serve watches main only after its own merges. */
export function configuredMainWatch(env: NodeJS.ProcessEnv): MainWatchPorts | undefined {
  const { agentChatBin, hubSeat } = loadConfig(configPath(env)).shepherd ?? {};
  if (!agentChatBin) return undefined;
  const agents = agentChatAgents(agentChatBin, { timeoutMs: AGENT_CALL_TIMEOUT_MS });
  return { hubSeat: () => hubSeat, send: (seat, text) => agents.message(seat, text) };
}

/** Park and retire go over the same `agent-chat` CLI; the retire is never forced, and a park refuses a tree that holds unpushed or uncommitted work. */
export function configuredFixerRetire(env: NodeJS.ProcessEnv): FixerRetirePorts | undefined {
  const { agentChatBin } = loadConfig(configPath(env)).shepherd ?? {};
  if (!agentChatBin) return undefined;
  const agents = agentChatCleanupAgents(agentChatBin);
  return { roster: () => agents.roster(), park: async (name) => void (await parkAgent(agentChatBin, name, DEFAULT_PARK_TIMEOUT_MS)), retire: (name) => agents.retire(name) };
}
