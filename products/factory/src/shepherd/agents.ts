import { assertInstalledHeadless, dispatchToAgentChat, messageAgent, resumeAgent, retire, type AgentRow } from "@titan-design/agent-dispatch";
import { agentChatRoster, mutating, type RosterReader } from "./roster.js";
import type { SpawnGate } from "./spawn-gate.js";

export const AGENT_CALL_TIMEOUT_MS = 90_000;

/** Every agent this adapter starts is Shepherd's, so its roster row says so (CC-1466); a record, never `--spawned-as`. */
const SHEPHERD_LAUNCH = { launchedBy: "shepherd" } as const;

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
  /** This spawn's Claude config directory, picked per spawn; absent means the adapter's own `configDir`. */
  configDir?: string;
}

/** Shepherd's one adapter over the `agent-chat` CLI; each caller picks its profile per spawn. */
export interface AgentChatAgents {
  roster(): Promise<readonly AgentRow[]>;
  spawn(request: SpawnRequest): Promise<void>;
  /** Resuming an exited agent starts a process like a spawn does, so it passes the same gate. */
  resume(name: string, message: string): Promise<void>;
  /** Delivers `message` to a live agent as one chat message. */
  message(name: string, message: string): Promise<void>;
  /** Never forced, so agent-chat refuses it while the agent's worktree holds work that is not pushed; absent on adapters that never retire. */
  retire?(name: string): Promise<void>;
}

/** The check `spawn` makes before agent-chat runs, asked ahead of time, so a panel plan can refuse a profile its dispatch would. */
export function installedHeadless(profile: string, dir?: string): boolean {
  try {
    assertInstalledHeadless(profile, dir);
    return true;
  } catch {
    return false;
  }
}

/** Every mutation invalidates `roster`, so the read that checks whether it took effect is never a cached one. */
export function agentChatAgents(agentChatBin: string, options: AgentChatOptions = {}): AgentChatAgents {
  const { timeoutMs = AGENT_CALL_TIMEOUT_MS, roster = agentChatRoster(agentChatBin), gate } = options;
  return {
    roster: () => roster.rows(),
    spawn: ({ name, profile, brief, cwd, configDir = options.configDir }) =>
      mutating(roster, async () => {
        gate?.admit(name);
        await dispatchToAgentChat({ agentChatBinPath: agentChatBin, peerName: name, profile, brief, cwd, ...SHEPHERD_LAUNCH, ...(configDir !== undefined && { configDir }) }, timeoutMs, [profile]);
      }),
    resume: (name, message) =>
      mutating(roster, async () => {
        gate?.admit(name);
        await resumeAgent(agentChatBin, name, message, timeoutMs, SHEPHERD_LAUNCH);
      }),
    message: (name, message) => mutating(roster, async () => { await messageAgent(agentChatBin, name, message, timeoutMs); }),
    retire: (name) => mutating(roster, async () => void (await retire(agentChatBin, name, timeoutMs))),
  };
}
