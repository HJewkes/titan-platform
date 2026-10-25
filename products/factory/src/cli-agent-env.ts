import type { Verbs } from "./cli.js";
import { unansweredMessage } from "./cli-shepherd-rpc.js";
import { EXIT } from "./exit-codes.js";
import { probeServe } from "./serve-probe.js";

/** An agent holds no write credentials of its own: its writes go through serve, which does. */
const inAgentEnv = (env: NodeJS.ProcessEnv): boolean => Boolean(env.AGENT_CHAT_AGENT_ID);

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

/**
 * For a write verb with no serve route: its in-process run is its only path, so an agent env never takes it, whatever answers on a port.
 * True when it has printed the refusal and set the exit.
 */
export function refusedAgentWrite(verbs: Verbs, verb: string): boolean {
  if (!inAgentEnv(verbs.io.env)) return false;
  verbs.io.stderr(`error: ${verb} has no titan-factory serve route and would write in-process, which an agent env refuses, so nothing was done\n`);
  verbs.setExit(EXIT.UNAVAILABLE);
  return true;
}
