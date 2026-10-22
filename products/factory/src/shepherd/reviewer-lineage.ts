import type { AgentRow } from "@titan-design/agent-dispatch";

/** The roster fields a reviewer's lineage is read from. */
export type LineageRow = Pick<AgentRow, "name" | "agentId" | "sessionId" | "spawnedBy" | "teleportFrom">;

interface ReviewerIdentity {
  agentId: string;
  sessionId: string;
}

/** Shepherd spawns through the CLI, which the broker records as the human: such a spawn starts a fresh conversation. */
const CLI_SPAWNER = "human";

interface Line {
  names: Set<string>;
  agentIds: Set<string>;
  sessionIds: Set<string>;
}

/**
 * The rows one row shares a conversation with: its other sessions and resumes (same name, agent or session), the session that
 * spawned it, which may have forked its own context into it, and the agent it was teleported from. Undefined when a link names
 * a row the roster does not hold.
 */
function linkedRows(row: LineageRow, roster: readonly LineageRow[]): LineageRow[] | undefined {
  const same = roster.filter((other) => other.name === row.name || other.agentId === row.agentId || (row.sessionId !== "" && other.sessionId === row.sessionId));
  const spawner = row.spawnedBy ?? null;
  const parents = spawner === null || spawner === CLI_SPAWNER ? [] : roster.filter((other) => other.name === spawner);
  const teleported = row.teleportFrom ? roster.filter((other) => other.agentId === row.teleportFrom) : [];
  if ((parents.length === 0 && spawner !== null && spawner !== CLI_SPAWNER) || (row.teleportFrom && teleported.length === 0)) return undefined;
  return [...same, ...parents, ...teleported];
}

/** Every name, agent and session the reviewer's conversation descends from or continues as; undefined when any link cannot be read. */
function lineOf(reviewer: ReviewerIdentity, roster: readonly LineageRow[]): Line | undefined {
  const queue = roster.filter((row) => row.agentId === reviewer.agentId);
  if (queue.length === 0) return undefined;
  const line: Line = { names: new Set(), agentIds: new Set([reviewer.agentId]), sessionIds: new Set([reviewer.sessionId]) };
  const seen = new Set<LineageRow>();
  for (let row = queue.pop(); row !== undefined; row = queue.pop()) {
    if (seen.has(row)) continue;
    seen.add(row);
    line.names.add(row.name);
    line.agentIds.add(row.agentId);
    if (row.sessionId !== "") line.sessionIds.add(row.sessionId);
    const linked = linkedRows(row, roster);
    if (linked === undefined) return undefined;
    queue.push(...linked);
  }
  return line;
}

const meets = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => [...a].some((item) => b.has(item));

/**
 * True only when the roster proves two reviewers share no conversation: different sessions, and no resume, fork, takeover or
 * common spawning session links them. A reviewer missing from the roster, or a link it cannot follow, is not proven separate.
 */
export function separateLineages(a: ReviewerIdentity, b: ReviewerIdentity, roster: readonly LineageRow[]): boolean {
  const lineA = lineOf(a, roster);
  const lineB = lineOf(b, roster);
  if (lineA === undefined || lineB === undefined) return false;
  return !meets(lineA.names, lineB.names) && !meets(lineA.agentIds, lineB.agentIds) && !meets(lineA.sessionIds, lineB.sessionIds);
}
