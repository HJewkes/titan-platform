/**
 * Park an exited agent's worktree through `agent-chat agent park` (CC-282): the
 * broker removes the tree when it is clean and pushed and keeps the branch, and
 * `agent resume` re-creates it later. The broker refuses a live, detached,
 * dirty, unpushed or shared tree; that refusal reaches the caller as a
 * `DispatchError` carrying the broker's reason.
 */

import { refusal, runAgentChat } from "./agents.js";
import { DispatchError, PEER_NAME_PATTERN } from "./dispatch.js";

/** Removing a worktree is a git call on the broker's side, so this allows more than a roster read. */
export const DEFAULT_PARK_TIMEOUT_MS = 60_000;

export interface ParkResult {
  name: string;
  /** agent-chat's report, verbatim: what was parked and how to bring it back. */
  lines: string[];
}

export function buildParkArgs(name: string): string[] {
  return ["agent", "park", name];
}

/** Remove the agent's worktree and keep its branch; throws `DispatchError` when the broker refuses. */
export function parkAgent(
  agentChatBinPath: string,
  name: string,
  timeoutMs = DEFAULT_PARK_TIMEOUT_MS,
): ParkResult {
  if (!PEER_NAME_PATTERN.test(name)) {
    throw new DispatchError(`invalid peer name: '${name}'`);
  }
  const result = runAgentChat(agentChatBinPath, buildParkArgs(name), timeoutMs);
  if (result.status !== 0) throw refusal("agent park", result);
  const lines = result.stdout.split("\n").map((line) => line.trim());
  return { name, lines: lines.filter((line) => line !== "") };
}
