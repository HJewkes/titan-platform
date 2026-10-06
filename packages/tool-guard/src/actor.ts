import type { ActorClass } from "@titan-design/authority";

/** Set at launch (`TITAN_TOOL_GUARD_BYPASS=1 claude`) to run a session with owner authority (owner decision D3). */
export const BYPASS_VAR = "TITAN_TOOL_GUARD_BYPASS";

/** Every agent class the hook cannot rule out (owner decision D2): markers in the env do not narrow it. */
export const AGENT_CANDIDATES: readonly ActorClass[] = ["coordinator", "worker", "headless"];

/** Who made the call, as far as the hook can tell. The classifier never decides this. */
export interface ActorObservation {
  candidates: readonly ActorClass[];
  /** `AGENT_CHAT_AGENT_ID`, else the session id, else `unknown`. */
  id: string;
  bypass: boolean;
}

/**
 * The actor for one event. `env` must be the hook process's own env from launch: a model's inline
 * `TITAN_TOOL_GUARD_BYPASS=1 cmd` sets it only for `cmd`, which never reaches this process.
 */
export function observeActor(env: Readonly<Record<string, string | undefined>>, sessionId: string | null): ActorObservation {
  const bypass = env[BYPASS_VAR] === "1";
  const agentId = env.AGENT_CHAT_AGENT_ID;
  const id = agentId !== undefined && agentId !== "" ? agentId : (sessionId ?? "unknown");
  return { candidates: bypass ? ["owner-terminal"] : AGENT_CANDIDATES, id, bypass };
}
