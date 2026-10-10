import { configPath, loadConfig } from "./config.js";
import { AGENT_CALL_TIMEOUT_MS, agentChatAgents } from "./shepherd/agents.js";
import type { MainWatchPorts } from "./shepherd/main-watch.js";

/** A red event goes out over agent-chat, so no configured `agentChatBin` means serve watches main only after its own merges. */
export function configuredMainWatch(env: NodeJS.ProcessEnv): MainWatchPorts | undefined {
  const { agentChatBin, hubSeat } = loadConfig(configPath(env)).shepherd ?? {};
  if (!agentChatBin) return undefined;
  const agents = agentChatAgents(agentChatBin, { timeoutMs: AGENT_CALL_TIMEOUT_MS });
  return { hubSeat: () => hubSeat, send: (seat, text) => agents.message(seat, text) };
}
