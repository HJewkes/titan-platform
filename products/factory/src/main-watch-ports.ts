import { DEFAULT_PARK_TIMEOUT_MS, parkAgent, receivesMessages } from "@titan-design/agent-dispatch";
import { configPath, loadConfig, type FactoryConfig } from "./config.js";
import { AGENT_CALL_TIMEOUT_MS, agentChatAgents } from "./shepherd/agents.js";
import { agentChatCleanupAgents } from "./shepherd/cleanup-ports.js";
import type { FixerRetirePorts } from "./shepherd/fixer-retire.js";
import type { MainWatchPorts } from "./shepherd/main-watch.js";

type RedSeatConfig = NonNullable<FactoryConfig["shepherd"]>["redSeat"];

/** A red event goes out over agent-chat, so no configured `agentChatBin` means serve watches main only after its own merges. */
export function configuredMainWatch(env: NodeJS.ProcessEnv): MainWatchPorts | undefined {
  const { agentChatBin, hubSeat, redSeat } = loadConfig(configPath(env)).shepherd ?? {};
  if (!agentChatBin) return undefined;
  const agents = agentChatAgents(agentChatBin, { timeoutMs: AGENT_CALL_TIMEOUT_MS });
  const liveNames = async () => new Set((await agents.roster()).filter(receivesMessages).map((row) => row.name));
  return { hubSeat: () => hubSeat, redSeat: (repo) => redSeatFor(redSeat, repo), send: (seat, text) => agents.message(seat, text), liveNames };
}

/** The repo's entry, its key matched in any case, else the fallback. */
function redSeatFor(config: RedSeatConfig | undefined, repo: string): string | undefined {
  const entry = Object.entries(config?.repos ?? {}).find(([key]) => key.toLowerCase() === repo.toLowerCase());
  return entry?.[1] ?? config?.fallback;
}

/** Park and retire go over the same `agent-chat` CLI; the retire is never forced, and a park refuses a tree that holds unpushed or uncommitted work. */
export function configuredFixerRetire(env: NodeJS.ProcessEnv): FixerRetirePorts | undefined {
  const { agentChatBin } = loadConfig(configPath(env)).shepherd ?? {};
  if (!agentChatBin) return undefined;
  const agents = agentChatCleanupAgents(agentChatBin);
  return { roster: () => agents.roster(), park: async (name) => void (await parkAgent(agentChatBin, name, DEFAULT_PARK_TIMEOUT_MS)), retire: (name) => agents.retire(name) };
}
