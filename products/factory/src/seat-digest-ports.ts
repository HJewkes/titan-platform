import { configPath, loadConfig } from "./config.js";
import { AGENT_CALL_TIMEOUT_MS, agentChatAgents } from "./shepherd/agents.js";
import { fallbackSeats, singleSeat } from "./shepherd/exit-notice.js";
import type { SeatDigestPorts } from "./shepherd/seat-digest.js";
import { loadSeatBook } from "./shepherd/seats.js";

/**
 * A digest goes out over agent-chat, so no configured `agentChatBin` means serve sends none. The seat book, roster and
 * the notices' fallback seats (`shepherd.redSeat`, `shepherd.hubSeat`) are re-read per sweep.
 */
export function configuredSeatDigest(env: NodeJS.ProcessEnv): SeatDigestPorts | undefined {
  const { agentChatBin } = loadConfig(configPath(env)).shepherd ?? {};
  if (!agentChatBin) return undefined;
  const agents = agentChatAgents(agentChatBin, { timeoutMs: AGENT_CALL_TIMEOUT_MS });
  const shepherd = () => loadConfig(configPath(env)).shepherd ?? {};
  return {
    seatLookup: () => {
      const book = loadSeatBook(shepherd());
      return (repo) => singleSeat(book, repo);
    },
    roster: () => agents.roster(),
    fallbackSeats: (repo) => {
      const { hubSeat, redSeat } = shepherd();
      return fallbackSeats({ hubSeat, redSeat }, repo);
    },
    send: (seat, text) => agents.message(seat, text),
  };
}
