/**
 * A spawn made on behalf of whoever runs this process, a human in a terminal
 * or an agent in its Bash tool, rather than on behalf of a daemon.
 *
 * `dispatchToAgentChat` reaches the broker as the human on purpose: its
 * callers are daemons whose environment says nothing about who asked. Here the
 * caller's identity is the point. agent-chat's CLI reads `AGENT_CHAT_NAME` or
 * `AGENT_CHAT_AGENT_ID` to name the spawner, which keeps the coordinator depth
 * cap and the Remote Control rule on an agent's spawn, and `CLAUDE_CONFIG_DIR`
 * as the spawner's account, which a least-used pick prefers on a tie. Those
 * three are forwarded when set, and nothing else from the caller's
 * environment is.
 *
 * No profile allowlist or headless check: the caller names the profile, and
 * the broker applies the same gates to it as to any spawn the caller makes
 * with the CLI directly. The brief still travels on stdin.
 */

import {
  DispatchError,
  PEER_NAME_PATTERN,
  agentChatEnv,
  buildSpawnArgs,
  runSpawn,
  type SpawnPlacement,
} from "./dispatch.js";

export const CALLER_IDENTITY_VARS = ["AGENT_CHAT_NAME", "AGENT_CHAT_AGENT_ID", "CLAUDE_CONFIG_DIR"] as const;

export interface SpawnAsCallerRequest extends SpawnPlacement {
  agentChatBinPath: string;
  name: string;
  profile: string;
  brief: string;
  /** The directory the CLI sends to the broker as the spawn location. */
  cwd: string;
  /** active-work slug whose orientation agent-chat prepends to the brief. */
  briefing?: string;
}

export interface SpawnAsCallerResult {
  name: string;
  /** agent-chat's stdout, one entry per non-empty line, such as the account choice and the `Spawned` line. */
  lines: string[];
}

/** `agentChatEnv()` plus each identity variable the caller's environment has a non-empty value for. */
export function callerEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = agentChatEnv();
  for (const key of CALLER_IDENTITY_VARS) {
    const value = source[key];
    if (value) env[key] = value;
  }
  return env;
}

/** Starts the agent as the caller; a zero exit means the broker accepted the spawn, not that the work is done. */
export async function spawnAsCaller(req: SpawnAsCallerRequest, timeoutMs: number): Promise<SpawnAsCallerResult> {
  if (!PEER_NAME_PATTERN.test(req.name)) {
    throw new DispatchError(`invalid peer name: '${req.name}'`);
  }
  const args = buildSpawnArgs({ ...req, peerName: req.name });
  const result = await runSpawn(req, args, callerEnv(), timeoutMs);
  return { name: req.name, lines: result.stdout.split("\n").filter((line) => line.trim() !== "") };
}
