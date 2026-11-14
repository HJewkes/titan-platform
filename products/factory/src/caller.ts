import type { Surface } from "@titan-design/daemon";

/** Who a needs read is for. Only the owner sees items from initiatives withheld from agents. */
export type Caller = "owner" | "agent";

/** The console reaches serve over loopback HTTP; MCP is how agents reach it. */
export function callerForSurface(surface: Surface): Caller {
  return surface === "http" ? "owner" : "agent";
}

const AGENT_SHELL_VARS = ["AGENT_CHAT_NAME", "AGENT_CHAT_AGENT_ID", "CLAUDECODE"] as const;

/**
 * A shell is the owner's only when no agent marker is set. CLAUDECODE counts too, so the owner running a verb inside
 * Claude Code gets the agent view: an over-restricted owner can open a plain terminal, a leaked item cannot be unread.
 */
export function callerForShell(env: NodeJS.ProcessEnv): Caller {
  return AGENT_SHELL_VARS.some((name) => Boolean(env[name])) ? "agent" : "owner";
}
