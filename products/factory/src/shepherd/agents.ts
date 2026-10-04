import { dispatchToAgentChat, messageAgent, resumeAgent, type AgentRow } from "@titan-design/agent-dispatch";
import { agentChatRoster, mutating, type RosterReader } from "./roster.js";

export const AGENT_CALL_TIMEOUT_MS = 30_000;

export interface AgentChatOptions {
  /** The Claude config directory every spawn runs under; absent means agent-chat's default account. */
  configDir?: string;
  timeoutMs?: number;
  roster?: RosterReader;
}

export interface SpawnRequest {
  name: string;
  profile: string;
  brief: string;
  cwd: string;
}

/** Shepherd's one adapter over the `agent-chat` CLI; each caller picks its profile per spawn. */
export interface AgentChatAgents {
  roster(): Promise<readonly AgentRow[]>;
  spawn(request: SpawnRequest): Promise<void>;
  resume(name: string, message: string): Promise<void>;
  /** Delivers `message` to a live agent as one chat message. */
  message(name: string, message: string): Promise<void>;
}

/** Every mutation invalidates `roster`, so the read that checks whether it took effect is never a cached one. */
export function agentChatAgents(agentChatBin: string, options: AgentChatOptions = {}): AgentChatAgents {
  const { configDir, timeoutMs = AGENT_CALL_TIMEOUT_MS, roster = agentChatRoster(agentChatBin) } = options;
  return {
    roster: () => roster.rows(),
    spawn: ({ name, profile, brief, cwd }) =>
      mutating(roster, async () => void dispatchToAgentChat({ agentChatBinPath: agentChatBin, peerName: name, profile, brief, cwd, ...(configDir !== undefined && { configDir }) }, timeoutMs, [profile])),
    resume: (name, message) => mutating(roster, async () => void resumeAgent(agentChatBin, name, message, timeoutMs)),
    message: (name, message) => mutating(roster, async () => messageAgent(agentChatBin, name, message, timeoutMs)),
  };
}
