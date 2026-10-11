import { configPath, loadConfig } from "./config.js";
import { AGENT_CALL_TIMEOUT_MS, agentChatAgents } from "./shepherd/agents.js";
import { singleSeat } from "./shepherd/exit-notice.js";
import type { SeatDigestPorts } from "./shepherd/seat-digest.js";
import { loadSeatBook } from "./shepherd/seats.js";

/** A digest goes out over agent-chat, so no configured `agentChatBin` means serve sends none. The seat book is re-read per sweep. */
export function configuredSeatDigest(env: NodeJS.ProcessEnv): SeatDigestPorts | undefined {
  const { agentChatBin } = loadConfig(configPath(env)).shepherd ?? {};
  if (!agentChatBin) return undefined;
  const agents = agentChatAgents(agentChatBin, { timeoutMs: AGENT_CALL_TIMEOUT_MS });
  return {
    seatLookup: () => {
      const book = loadSeatBook(loadConfig(configPath(env)).shepherd ?? {});
      return (repo) => singleSeat(book, repo);
    },
    send: (seat, text) => agents.message(seat, text),
  };
}
