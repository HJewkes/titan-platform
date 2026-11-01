import type { AgentChatAgents } from "./agents.js";

export type VisualPacketMode = "off" | "shadow" | "on";

/** `shepherd.visualPacket` and what an `on` spawn needs; absent reads as `off`. */
export interface VisualPacketPorts {
  mode: VisualPacketMode;
  profile: string;
  /** The factory state dir; each packet goes under `<stateDir>/packets/<run id>/<head sha>`. */
  stateDir: string;
  /** Absent means no agent-chat is configured, so an `on` spawn is recorded as failed. */
  agents?: Pick<AgentChatAgents, "roster" | "spawn">;
  /** The repo's seat checkout: the packager starts in it, and from-ci and the lint read git objects from it. None spawns nothing. */
  cwdFor?: (repo: string) => string | undefined;
  /** `shepherd.titanReviewBin`; absent means `$HOME/.local/bin/titan-review`, named in full as `~/.local/bin` is not on every PATH. */
  titanReviewBin?: string;
}

/** How the diagnosis planner is spawned; the profile is passed to agent-chat as configured, never lowered. */
export interface DiagnosisPorts {
  profile: string;
  /** Absent means no agent-chat is configured, so the spawn is recorded as failed and the ops notice goes instead. */
  agents?: Pick<AgentChatAgents, "roster" | "spawn">;
  /** The repo's checkout, which the planner starts in. */
  cwdFor?: (repo: string) => string | undefined;
  /** The tail of `serve.err.log`; absent or undefined quotes no log lines. */
  readLog?: () => Promise<string | undefined>;
  /** The seat the planner reports to; absent means it reports to its spawner. */
  reportTo?: () => string | undefined;
}
