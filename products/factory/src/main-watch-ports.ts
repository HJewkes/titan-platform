import { fileURLToPath } from "node:url";
import { DEFAULT_PARK_TIMEOUT_MS, parkAgent, receivesMessages } from "@titan-design/agent-dispatch";
import { deployCheckoutAncestry } from "./build-ancestry.js";
import { FACTORY_REPO } from "./build-info.js";
import { deployCheckoutFor } from "./cli-service.js";
import { configPath, factoryStateDir, loadConfig, type FactoryConfig } from "./config.js";
import { AGENT_CALL_TIMEOUT_MS, agentChatAgents } from "./shepherd/agents.js";
import { agentChatCleanupAgents } from "./shepherd/cleanup-ports.js";
import type { FixerRetirePorts } from "./shepherd/fixer-retire.js";
import type { MainDeploy, MainWatchPorts } from "./shepherd/main-watch.js";
import { mainDeployQueue } from "./shepherd/redeploy.js";

type RedSeatConfig = NonNullable<FactoryConfig["shepherd"]>["redSeat"];

/** A red event goes out over agent-chat, so no configured `agentChatBin` means serve watches main only after its own merges. The seats are re-read per call, so an edit to `hubSeat` or `redSeat` applies without a restart. */
export function configuredMainWatch(env: NodeJS.ProcessEnv): MainWatchPorts | undefined {
  const shepherd = () => loadConfig(configPath(env)).shepherd ?? {};
  const { agentChatBin } = shepherd();
  if (!agentChatBin) return undefined;
  const agents = agentChatAgents(agentChatBin, { timeoutMs: AGENT_CALL_TIMEOUT_MS });
  const liveNames = async () => new Set((await agents.roster()).filter(receivesMessages).map((row) => row.name));
  const deploy = factoryDeploy(env);
  return { hubSeat: () => shepherd().hubSeat, redSeat: (repo) => redSeatFor(shepherd().redSeat, repo), send: (seat, text) => agents.message(seat, text), liveNames, ...(deploy && { deploy }) };
}

/** The same bin, state dir and ancestry probe Shepherd's redeploy step queues with, so both write one deploy-wanted.json. */
function factoryDeploy(env: NodeJS.ProcessEnv): MainDeploy | undefined {
  if (FACTORY_REPO === undefined) return undefined;
  const queue = mainDeployQueue({ bin: fileURLToPath(new URL("./bin.js", import.meta.url)), stateDir: factoryStateDir(env), isAncestor: deployCheckoutAncestry(deployCheckoutFor(env)) });
  return { repo: FACTORY_REPO, queue };
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
