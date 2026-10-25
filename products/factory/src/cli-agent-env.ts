import type { Verbs } from "./cli.js";
import { unansweredMessage } from "./cli-shepherd-rpc.js";
import { EXIT } from "./exit-codes.js";
import { probeServe } from "./serve-probe.js";

/** An agent holds no write credentials of its own: its writes go through serve, which does. */
export const inAgentEnv = (env: NodeJS.ProcessEnv): boolean => Boolean(env.AGENT_CHAT_AGENT_ID);

/**
 * True when this verb must not run its in-process fallback: an agent env with no serve answering.
 * It has already printed the refusal and set the exit; the caller returns without touching a port.
 */
export async function refusedWriteFallback(verbs: Verbs, port: number, verb: string): Promise<boolean> {
  if (!inAgentEnv(verbs.io.env)) return false;
  const probe = await probeServe(port, verbs.deps.serveWaitMs);
  if (probe.state === "up") return false;
  verbs.io.stderr(`error: ${unansweredMessage(probe, port)}; ${verb} would write in-process, which an agent env refuses, so nothing was done\n`);
  verbs.setExit(EXIT.UNAVAILABLE);
  return true;
}
