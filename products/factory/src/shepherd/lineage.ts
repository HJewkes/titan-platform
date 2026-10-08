import type { ReviewerAgent } from "./review.js";

type Parents = (agent: ReviewerAgent) => readonly (string | null | undefined)[];
const takeovers: Parents = (agent) => [agent.predecessor];
const descent: Parents = (agent) => [agent.spawnedBy, agent.predecessor];

/** `name` and every name above it; undefined when a link is absent from the roster, has no stored lineage, or loops back. */
function ancestry(name: string, roster: readonly ReviewerAgent[], parents: Parents, path: readonly string[] = []): ReadonlySet<string> | undefined {
  if (path.includes(name)) return undefined;
  const rows = roster.filter((agent) => agent.name === name);
  if (rows.length === 0 || rows.some((agent) => agent.predecessor === undefined)) return undefined;
  const found = new Set([name]);
  for (const parent of rows.flatMap(parents)) {
    if (parent === null || parent === undefined) continue;
    const above = ancestry(parent, roster, parents, [...path, name]);
    if (!above) return undefined;
    above.forEach((ancestor) => found.add(ancestor));
  }
  return found;
}

/** Proven only from roster facts: nobody who wrote the code is the agent, spawned it, or handed over to it, at any depth. */
export function provablyIndependent(agent: ReviewerAgent, implementer: string, roster: readonly ReviewerAgent[]): boolean {
  const wrote = ancestry(implementer, roster, takeovers);
  const above = ancestry(agent.name, roster, descent);
  return wrote !== undefined && above !== undefined && ![...wrote].some((author) => above.has(author));
}
