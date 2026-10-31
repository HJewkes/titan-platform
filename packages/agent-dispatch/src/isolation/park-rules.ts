import { existsSync } from "node:fs";
import { isLive, type WorktreeRecord } from "@titan-design/worktree";
import type { JournalRow } from "../host/ports.js";
import type { AgentIdentity } from "../roster/types.js";
import { parkTenancyBlocker } from "./tenancy.js";

/**
 * CC-282: who may have a finished agent's worktree parked. Parking removes the tree and keeps
 * the branch, so `agent resume` re-creates it at the same path. These are the pure rules; the
 * removal itself and its process and unsaved-work checks live beside the worktree strategy.
 */

/** The worktree an agent's newest `isolation_allocated` row records, and whether it was adopted rather than created. */
export interface ParkTarget extends WorktreeRecord {
  assigned: boolean;
}

function newestAllocation(rows: readonly JournalRow[], agentId: string): JournalRow | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row?.kind === "isolation_allocated" && row.ref === agentId) return row;
  }
  return undefined;
}

export function allocatedWorktree(
  rows: readonly JournalRow[],
  agentId: string,
): ParkTarget | undefined {
  const meta = newestAllocation(rows, agentId)?.meta;
  if (meta?.strategy !== "worktree") return undefined;
  const { gitRoot, worktree, branch } = meta;
  if (!gitRoot || !worktree || !branch) return undefined;
  return { gitRoot, worktree, branch, assigned: meta.assigned === "true" };
}

/** Parkable: exited, or detached with no process this broker tracks (the state after a broker restart). */
function stateBlocker(agent: AgentIdentity, tracked: boolean): string | undefined {
  const finished = agent.state === "exited" || agent.state === "detached";
  if (finished && !tracked) return undefined;
  const state = agent.state === "exited" ? "still tracked as running" : agent.state;
  return `${agent.name} is ${state}; park takes only an agent whose process has exited or that this broker no longer tracks`;
}

/** Why `agent` cannot be parked, or undefined when it can. `tracked` means this broker still watches its process. */
export function parkBlocker(
  agent: AgentIdentity,
  tracked: boolean,
  target: ParkTarget | undefined,
  roster: readonly AgentIdentity[],
): string | undefined {
  const byState = stateBlocker(agent, tracked);
  if (byState) return byState;
  if (target === undefined) return `${agent.name} holds no worktree agent-chat allocated`;
  if (!existsSync(target.worktree)) return `${target.worktree} is not on disk; nothing to park`;
  const byTenant = parkTenancyBlocker(agent, target.worktree, roster);
  if (byTenant) return byTenant;
  if (target.assigned)
    return `${target.worktree} was adopted by ${agent.name}, not allocated, so resume could not re-create it; park its owner instead`;
  return undefined;
}

/** An adopted tree belongs to its owner and a gone one has nothing left to remove. */
export const parkable = (target: ParkTarget | undefined): target is ParkTarget =>
  target !== undefined && !target.assigned && existsSync(target.worktree);

/** `tracked` means this broker still watches the agent's process, which a detached agent can have. */
export function liveBlocker(agent: AgentIdentity, tracked: boolean): string | undefined {
  if (isLive(agent.state)) return agent.state;
  if (tracked) return `${agent.state}, but its process is still running`;
  return undefined;
}
