import type { Verbs } from "./cli.js";
import { unansweredMessage } from "./cli-shepherd-rpc.js";
import { EXIT } from "./exit-codes.js";
import { probeServe, type ServeProbe } from "./serve-probe.js";

/** An agent holds no write credentials of its own: its writes go through serve, which does. */
const inAgentEnv = (env: NodeJS.ProcessEnv): boolean => Boolean(env.AGENT_CHAT_AGENT_ID);

/**
 * Called where a verb has already decided, from its one probe, to run in-process. True when an agent env refuses that:
 * it has printed the refusal and set the exit, and the caller returns without touching a port.
 */
export function refusedInProcess(verbs: Verbs, probe: ServeProbe, port: number, verb: string): boolean {
  if (!inAgentEnv(verbs.io.env)) return false;
  verbs.io.stderr(`error: ${unansweredMessage(probe, port)}; ${verb} would write in-process, which an agent env refuses, so nothing was done\n`);
  verbs.setExit(EXIT.UNAVAILABLE);
  return true;
}

/** For a verb that always runs in-process and has no serve route of its own: it still refuses in an agent env when no serve answers. */
export async function refusedWithoutServe(verbs: Verbs, port: number, verb: string): Promise<boolean> {
  if (!inAgentEnv(verbs.io.env)) return false;
  const probe = await probeServe(port, verbs.deps.serveWaitMs);
  return probe.state === "up" ? false : refusedInProcess(verbs, probe, port, verb);
}
