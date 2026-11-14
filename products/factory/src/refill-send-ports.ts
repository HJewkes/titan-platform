import { configPath, loadConfig } from "./config.js";
import { AGENT_CALL_TIMEOUT_MS, agentChatAgents } from "./shepherd/agents.js";

/**
 * The ready-stock refill request goes out over agent-chat, so no configured `shepherd.agentChatBin` means none is sent.
 * It lives outside the shadow dispatcher's fenced files, which may import no launch path; the CLI injects it.
 */
export function configuredRefillSend(env: NodeJS.ProcessEnv): ((to: string, text: string) => Promise<void>) | undefined {
  const bin = loadConfig(configPath(env)).shepherd?.agentChatBin;
  if (!bin) return undefined;
  const agents = agentChatAgents(bin, { timeoutMs: AGENT_CALL_TIMEOUT_MS });
  return (to, text) => agents.message(to, text);
}
