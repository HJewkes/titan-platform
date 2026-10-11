import type { ActorClass } from "@titan-design/authority";

/** Every agent class the hook cannot rule out (owner decision D2): markers in the env do not narrow it. */
export const AGENT_CANDIDATES: readonly ActorClass[] = ["coordinator", "worker", "headless"];

/** Who made the call, as far as the hook can tell. The classifier never decides this. */
export interface ActorObservation {
  candidates: readonly ActorClass[];
  /** `AGENT_CHAT_AGENT_ID`, else the session id, else `unknown`. */
  id: string;
}

/**
 * The actor for one event: always an agent. The hook runs as the same OS user as the agent, so no
 * variable, file or process fact it can read is one the agent could not produce, and owner authority
 * is never granted here. The owner takes a guarded action from a terminal outside Claude Code.
 */
export function observeActor(env: Readonly<Record<string, string | undefined>>, sessionId: string | null): ActorObservation {
  const agentId = env.AGENT_CHAT_AGENT_ID;
  const id = agentId !== undefined && agentId !== "" ? agentId : (sessionId ?? "unknown");
  return { candidates: AGENT_CANDIDATES, id };
}
