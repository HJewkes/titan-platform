import type { ActorClass } from "@titan-design/authority";
import type { Ancestor } from "./ancestry.js";

/** Set at launch (`TITAN_TOOL_GUARD_BYPASS=1 claude`) from a terminal to run a session with owner authority (owner decision D3). */
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
 * The session runs at an owner's terminal: the one Claude Code process above the hook has a terminal, and no
 * other runs above it. Any process an agent starts can put the variable in a child `claude`'s env, however it
 * spells it, but that child has the agent's own `claude` above it, or lost its terminal when it detached.
 */
function launchedByOwner(ancestry: readonly Ancestor[]): boolean {
  const sessions = ancestry.filter((a) => a.claude);
  return sessions.length === 1 && sessions[0]?.tty === true;
}

/**
 * The actor for one event. `env` must be the hook process's own env from launch: a model's inline
 * `TITAN_TOOL_GUARD_BYPASS=1 cmd` sets it only for `cmd`, which never reaches this process. `ancestry`
 * is read only when the variable is set, since walking the process table costs a `ps`.
 */
export function observeActor(
  env: Readonly<Record<string, string | undefined>>,
  sessionId: string | null,
  ancestry: () => readonly Ancestor[],
): ActorObservation {
  const bypass = env[BYPASS_VAR] === "1" && launchedByOwner(ancestry());
  const agentId = env.AGENT_CHAT_AGENT_ID;
  const id = agentId !== undefined && agentId !== "" ? agentId : (sessionId ?? "unknown");
  return { candidates: bypass ? ["owner-terminal"] : AGENT_CANDIDATES, id, bypass };
}
