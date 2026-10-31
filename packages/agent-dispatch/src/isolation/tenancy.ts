import { isLive } from "@titan-design/worktree";
import type { AgentIdentity } from "../roster/types.js";
import { canonicalPath, isAtOrUnder } from "./paths.js";

/**
 * CC-141: a successor spawned with `worktree:` adopts its predecessor's tree, and adoption
 * leaves ownership with the predecessor, so retiring or parking the predecessor would pull
 * the tree out from under the successor. "Still working" means any identity that is not
 * retired: an exited or detached agent can still be resumed into that cwd. Every roster
 * passed here is the not-retired roster; the retire, bulk-retire and park paths share these
 * rules so the refusal cannot hold on one path and lapse on another.
 */

/** Every identity other than `agentId` whose cwd is the tree or anywhere inside it, symlinks resolved. */
export function tenantsOf(
  worktree: string,
  agentId: string,
  roster: readonly AgentIdentity[],
): AgentIdentity[] {
  const tree = canonicalPath(worktree);
  return roster.filter(
    (a) => a.agentId !== agentId && a.cwd !== "" && isAtOrUnder(canonicalPath(a.cwd), tree),
  );
}

/** A live agent whose cwd is the tree or anywhere inside it, whatever its name or branch (CC-277). */
export function occupantOf(
  worktree: string,
  roster: readonly AgentIdentity[],
): AgentIdentity | undefined {
  const tree = canonicalPath(worktree);
  return roster.find(
    (agent) => isLive(agent.state) && agent.cwd !== "" && isAtOrUnder(canonicalPath(agent.cwd), tree),
  );
}

/** The agent being retired, with the isolation it holds. */
export interface TreeHolder {
  agentId: string;
  name: string;
  isolation: string;
  /** The allocation's ref: `worktree`, `branch` and `assigned` are read. */
  ref?: Readonly<Record<string, string>>;
}

export interface TenancyVerdict {
  refusal?: string;
  warning?: string;
}

/** A retire of a tree another identity works in is refused; `--force` releases it and says so. */
export function worktreeTenancy(
  holder: TreeHolder,
  roster: readonly AgentIdentity[],
  force: boolean,
): TenancyVerdict | undefined {
  const { ref, name } = holder;
  if (holder.isolation !== "worktree" || ref?.assigned === "true" || !ref?.worktree) return undefined;
  const tree = canonicalPath(ref.worktree);
  const tenants = tenantsOf(tree, holder.agentId, roster).map((a) => a.name);
  if (tenants.length === 0) return undefined;
  const who = tenants.join(", ");
  if (!force)
    return {
      refusal:
        `${name} allocated the worktree ${tree}, and ${who} (not retired) is working in it. ` +
        `Retire ${who} first, or leave ${name} parked until that branch merges. ` +
        "Retire with --force to release it anyway.",
    };
  return {
    warning: `--force released the worktree ${tree} and branch ${ref.branch ?? "(unknown)"} while ${who} was still working in it`,
  };
}

/** The tree an agent allocated, as the bulk retire and park paths see it. */
export interface HeldTree {
  worktree: string;
  /** Adopted rather than allocated: not this agent's to remove. */
  assigned: boolean;
}

/** The bulk retire's form of the same rule: skip an agent whose allocated tree another identity works in. */
export function adopterBlocker(
  agent: AgentIdentity,
  target: HeldTree | undefined,
  roster: readonly AgentIdentity[],
): string | undefined {
  if (target === undefined || target.assigned) return undefined;
  const tenants = tenantsOf(target.worktree, agent.agentId, roster).map((a) => a.name);
  if (tenants.length === 0) return undefined;
  return `${tenants.join(", ")} (not retired) still works in its worktree`;
}

/** Park refuses while any other identity that is not retired works in the tree, live or not, since it could be resumed there. */
export function parkTenancyBlocker(
  agent: AgentIdentity,
  tree: string,
  roster: readonly AgentIdentity[],
): string | undefined {
  const others = roster.filter((a) => a.agentId !== agent.agentId);
  const occupant = occupantOf(tree, others);
  if (occupant) return `${occupant.name} is ${occupant.state} in ${tree}; not parked`;
  const tenants = tenantsOf(tree, agent.agentId, others);
  if (tenants.length === 0) return undefined;
  const who = tenants.map((a) => a.name).join(", ");
  return `${who} (not retired) also works in ${tree}, so parking ${agent.name} would pull it from under them; retire ${who} first`;
}
