import type { ReviewerAgent } from "@titan-design/review-panel";

type Parents = (agent: ReviewerAgent) => readonly (string | null | undefined)[];
const takeovers: Parents = (agent) => [agent.predecessor];
const descent: Parents = (agent) => [agent.spawnedBy, agent.predecessor];

/**
 * `name` and every name above it; undefined when a link is absent from the roster, has no stored lineage, or loops back
 * through another name. A row whose parent is its own name is a teleport generation of the same seat, not a loop.
 */
function ancestry(name: string, roster: readonly ReviewerAgent[], parents: Parents, path: readonly string[] = []): ReadonlySet<string> | undefined {
  if (path.includes(name)) return undefined;
  const rows = roster.filter((agent) => agent.name === name);
  if (rows.length === 0 || rows.some((agent) => agent.predecessor === undefined)) return undefined;
  const found = new Set([name]);
  for (const parent of rows.flatMap(parents)) {
    if (parent === null || parent === undefined || parent === name) continue;
    const above = ancestry(parent, roster, parents, [...path, name]);
    if (!above) return undefined;
    above.forEach((ancestor) => found.add(ancestor));
  }
  return found;
}

/**
 * The rows a lineage walk reads: the roster plus retired generations, whose spawners a teleported seat's live rows no
 * longer name. `complete` is false when the broker could not include the retired rows, and then nothing is proven.
 */
export interface Lineage {
  rows: readonly ReviewerAgent[];
  complete: boolean;
}

/** Proven only from roster facts: nobody who wrote the code is the agent, spawned it, or handed over to it, at any depth. */
export function provablyIndependent(agent: ReviewerAgent, implementer: string, lineage: Lineage): boolean {
  if (!lineage.complete) return false;
  const wrote = ancestry(implementer, lineage.rows, takeovers);
  const above = ancestry(agent.name, lineage.rows, descent);
  return wrote !== undefined && above !== undefined && ![...wrote].some((author) => above.has(author));
}
