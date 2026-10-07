import { dispatchToAgentChat, messageAgent, resumeAgent, type AgentRow } from "@titan-design/agent-dispatch";
import { agentChatRoster, mutating, type RosterReader } from "./roster.js";
import type { ReviewAsk, SpawnGate } from "./spawn-gate.js";

export const AGENT_CALL_TIMEOUT_MS = 30_000;

export interface AgentChatOptions {
  /** The Claude config directory every spawn runs under; absent means agent-chat's default account. */
  configDir?: string;
  timeoutMs?: number;
  roster?: RosterReader;
  /** Every spawn is admitted by it first; absent means spawns are not gated. */
  gate?: SpawnGate;
}

export interface SpawnRequest {
  name: string;
  profile: string;
  brief: string;
  cwd: string;
  /** Epoch-ms start of each review already running; those under five minutes old count against the build-capable load limit. */
  runningReviews?: readonly number[];
  /** Set for a reviewer's spawn only, so the gate can put a red main's fix ahead of other reviews. */
  review?: ReviewAsk;
}

/** Shepherd's one adapter over the `agent-chat` CLI; each caller picks its profile per spawn. */
export interface AgentChatAgents {
  roster(): Promise<readonly AgentRow[]>;
  spawn(request: SpawnRequest): Promise<void>;
  /** Resuming an exited agent starts a process like a spawn does, so it passes the same gate. */
  resume(name: string, message: string, runningReviews?: readonly number[], review?: ReviewAsk): Promise<void>;
  /** Delivers `message` to a live agent as one chat message. */
  message(name: string, message: string): Promise<void>;
}

/** Every mutation invalidates `roster`, so the read that checks whether it took effect is never a cached one. */
export function agentChatAgents(agentChatBin: string, options: AgentChatOptions = {}): AgentChatAgents {
  const { configDir, timeoutMs = AGENT_CALL_TIMEOUT_MS, roster = agentChatRoster(agentChatBin), gate } = options;
  return {
    roster: () => roster.rows(),
    spawn: ({ name, profile, brief, cwd, runningReviews, review }) =>
      mutating(roster, async () => {
        gate?.admit(name, runningReviews, review);
        await dispatchToAgentChat({ agentChatBinPath: agentChatBin, peerName: name, profile, brief, cwd, ...(configDir !== undefined && { configDir }) }, timeoutMs, [profile]);
      }),
    resume: (name, message, runningReviews, review) =>
      mutating(roster, async () => {
        gate?.admit(name, runningReviews, review);
        await resumeAgent(agentChatBin, name, message, timeoutMs);
      }),
    message: (name, message) => mutating(roster, async () => messageAgent(agentChatBin, name, message, timeoutMs)),
  };
}
