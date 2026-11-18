/** A named box outside the packages: a person or system that talks to the system. */
export interface ContextNode {
  id: string;
  label: string;
}

/** A labelled arrow between the system box, a package box, an actor or an external. */
export interface ContextLink {
  from: string;
  to: string;
  label: string;
}

/** The L0 context pass: who uses the system, what it depends on, and the arrows between them. */
export interface RepoMapContext {
  actors: readonly ContextNode[];
  externals: readonly ContextNode[];
  links: readonly ContextLink[];
}

export const SYS_ID = "sys";
export const CONTEXT_LEVEL = 0;

/** A level-0 box; the system box is a group, actors and externals are leaves with no parent. */
export interface ContextBox {
  id: string;
  label: string;
  level: number;
  kind: "system" | "actor" | "external";
  chain: string[];
}

/** A level-0 arrow, drawn as a protocol edge. */
export interface ContextEdge {
  srcId: string;
  dstId: string;
  kind: "calls";
  level: number;
  weight: number;
  edgeSource: "protocol";
  id: string;
  label: string;
}

export interface ContextPlan {
  system: ContextBox;
  outsiders: ContextBox[];
  edges: ContextEdge[];
}

const outsider = (kind: "actor" | "external") => (n: ContextNode): ContextBox => ({
  id: n.id,
  label: n.label,
  level: CONTEXT_LEVEL,
  kind,
  chain: [],
});

function contextEdge(link: ContextLink): ContextEdge {
  const { from: srcId, to: dstId, label } = link;
  return { srcId, dstId, kind: "calls", level: CONTEXT_LEVEL, weight: 1, edgeSource: "protocol", id: `context:${srcId}->${dstId}`, label };
}

/** Plan the level-0 boxes and arrows; a link end that is not sys, a package, an actor or an external throws. */
export function planContext(context: RepoMapContext, packageIds: ReadonlySet<string>): ContextPlan {
  const outsiders = [...context.actors.map(outsider("actor")), ...context.externals.map(outsider("external"))];
  const known = new Set([SYS_ID, ...packageIds, ...outsiders.map((o) => o.id)]);
  for (const link of context.links) {
    for (const end of [link.from, link.to]) {
      if (!known.has(end)) throw new Error(`repo-map: context link end ${end} is not sys, a package, an actor or an external`);
    }
  }
  const system: ContextBox = { id: SYS_ID, label: "System", level: CONTEXT_LEVEL, kind: "system", chain: [] };
  return { system, outsiders, edges: context.links.map(contextEdge) };
}
