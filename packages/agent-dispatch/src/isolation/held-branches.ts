import type { JournalRow } from "../host/ports.js";
import type { AgentIdentity } from "../roster/types.js";
import { allocatedWorktree, type ParkTarget } from "./park-rules.js";

/**
 * CC-1325: the bulk finished retire keeps an implementer or reviewer while a PR it worked on is open,
 * Shepherd-registered or not. Shepherd resumes a non-retired implementer warm and starts a cold
 * successor for a retired one, and a seat re-asks a reviewer by name. Overrides CC-950 for the bulk path only.
 */

export interface HeldBranch {
  gitRoot: string;
  branch: string;
}

/** `<base>-review`, `<base>-review-rN` (seat re-asks) and `<base>-rN` (burndown's reviewer). */
const REVIEWER_NAME = /^(.+?)-(?:review(?:-r\d+)?|r\d+)$/;

export function reviewedAgentName(name: string): string | undefined {
  return REVIEWER_NAME.exec(name)?.[1];
}

/** Every branch whose open PR holds `agent`; a branch with no repo to ask is dropped. */
export function heldBranches(
  agent: AgentIdentity,
  target: ParkTarget | undefined,
  roster: readonly AgentIdentity[],
  events: readonly JournalRow[]
): HeldBranch[] {
  const base = reviewedAgentName(agent.name);
  const baseTargets =
    base === undefined ? [] : baseRowTargets(base, roster, events);
  const gitRoot = target?.gitRoot ?? baseTargets[0]?.gitRoot;
  const named = [
    `agent-chat/${agent.name}`,
    ...(target ? [target.branch] : []),
  ];
  if (base !== undefined) named.push(`agent-chat/${base}`);
  const candidates = [
    ...(gitRoot === undefined
      ? []
      : named.map((branch) => ({ gitRoot, branch }))),
    ...baseTargets.map((t) => ({ gitRoot: t.gitRoot, branch: t.branch })),
  ];
  return [
    ...new Map(
      candidates.map((c) => [`${c.gitRoot}\0${c.branch}`, c])
    ).values(),
  ];
}

function baseRowTargets(
  base: string,
  roster: readonly AgentIdentity[],
  events: readonly JournalRow[]
): ParkTarget[] {
  return roster
    .filter((a) => a.name === base)
    .map((a) => allocatedWorktree(events, a.agentId))
    .filter((t): t is ParkTarget => t !== undefined);
}
