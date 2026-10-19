/**
 * Park an exited agent's worktree through `agent-chat agent park` (CC-282): the
 * broker removes the tree when it is clean and pushed and keeps the branch, and
 * `agent resume` re-creates it later. The broker refuses a live, detached,
 * dirty, unpushed or shared tree; that refusal reaches the caller as a
 * `DispatchError` carrying the broker's reason.
 */

import { refusal, runAgentChatAsync } from "./agents.js";
import { DispatchError, PEER_NAME_PATTERN } from "./dispatch.js";

/** Removing a worktree is a git call on the broker's side, so this allows more than a roster read. */
export const DEFAULT_PARK_TIMEOUT_MS = 60_000;

export interface ParkResult {
  name: string;
  /** agent-chat's report, verbatim: what was parked and how to bring it back. */
  lines: string[];
}

export interface ParkOptions {
  /** Shepherd sets it: agent-chat would otherwise ask Shepherd itself whether the agent is in a fix round (CC-1470). */
  noFixRoundCheck?: boolean;
}

export function buildParkArgs(name: string, options: ParkOptions = {}): string[] {
  return ["agent", "park", name, ...(options.noFixRoundCheck === true ? ["--no-fix-round-check"] : [])];
}

/**
 * Remove the agent's worktree and keep its branch; rejects with `DispatchError` when the broker refuses. Async because
 * `agent park` may read the caller back (agent-chat asks Shepherd about a fix round), and a blocked caller cannot answer.
 * The timeout has no default, so no call path can leave a park waiting on the broker without a bound it chose.
 */
export async function parkAgent(
  agentChatBinPath: string,
  name: string,
  timeoutMs: number,
  options: ParkOptions = {},
): Promise<ParkResult> {
  if (!PEER_NAME_PATTERN.test(name)) {
    throw new DispatchError(`invalid peer name: '${name}'`);
  }
  const result = await runAgentChatAsync(agentChatBinPath, buildParkArgs(name, options), timeoutMs);
  if (result.status !== 0) throw refusal("agent park", result);
  const lines = result.stdout.split("\n").map((line) => line.trim());
  return { name, lines: lines.filter((line) => line !== "") };
}
