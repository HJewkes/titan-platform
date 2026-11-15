import type { Db } from "@titan-design/store-sqlite";
import { seatGenerations, type SeatGenerationsInput } from "./seat-generations.js";

export type ChainLinkKind = "generation" | "predecessor";

/** One agent process in a session's chain. `kind` is how the walk back from the session reached it. */
export interface ChainLink {
  agentName: string | null;
  agentId: string | null;
  sessionIds: string[];
  start: string | null;
  end: string | null;
  kind: ChainLinkKind;
}

export type PredecessorChainInput = Omit<SeatGenerationsInput, "seat" | "since">;

interface AgentRow {
  agent_id: string | null;
  agent_name: string | null;
  predecessor: string | null;
}

const ORIGIN_OF_SESSION = "SELECT agent_id, agent_name, predecessor FROM session_origin WHERE session_id = ?";
const ORIGIN_OF_AGENT = "SELECT agent_id, agent_name, predecessor FROM session_origin WHERE agent_name = @ref OR agent_id = @ref ORDER BY spawned_at DESC, session_id DESC LIMIT 1";

/**
 * The session's agent and every agent before it, oldest first: the seat's earlier generations, then
 * the agent `session_origin.predecessor` names, then that agent's own generations, until no
 * predecessor is left or one names a seat already walked.
 */
export function predecessorChain(db: Db, sessionId: string, input: PredecessorChainInput): ChainLink[] {
  const origin = db.prepare<[string], AgentRow>(ORIGIN_OF_SESSION).get(sessionId);
  if (!origin?.agent_name) return [{ agentName: null, agentId: origin?.agent_id ?? null, sessionIds: [sessionId], start: null, end: null, kind: "generation" }];
  const newestFirst: ChainLink[] = [];
  const seen = new Set<string>();
  let anchor: { name: string; id: string | null } | null = { name: origin.agent_name, id: origin.agent_id };
  let kind: ChainLinkKind = "generation";
  while (anchor && !seen.has(anchor.name)) {
    seen.add(anchor.name);
    const segment = seatSegment(db, input, anchor.name, anchor.id, kind);
    newestFirst.push(...[...segment].reverse());
    anchor = predecessorOf(db, segment);
    kind = "predecessor";
  }
  return newestFirst.reverse();
}

/** The seat's generations oldest first up to the anchor agent; the anchor carries `kind`, earlier ones are generations. */
function seatSegment(db: Db, input: PredecessorChainInput, name: string, agentId: string | null, kind: ChainLinkKind): ChainLink[] {
  const all = seatGenerations({ ...input, seat: name });
  const cut = agentId ? all.findIndex((g) => g.agentId === agentId) : all.length - 1;
  const upTo = cut < 0 ? [] : all.slice(0, cut + 1);
  const links: ChainLink[] = upTo.map((g) => ({ agentName: name, agentId: g.agentId, sessionIds: g.sessionIds, start: g.start, end: g.end, kind: "generation" }));
  if (!links.length) {
    const id = agentId ?? lookupAgent(db, name)?.agent_id ?? null;
    links.push({ agentName: name, agentId: id, sessionIds: id ? [...(input.agentSessions.get(id) ?? [])] : [], start: null, end: null, kind });
  }
  links[links.length - 1]!.kind = kind;
  return links;
}

function lookupAgent(db: Db, ref: string): AgentRow | undefined {
  return db.prepare<{ ref: string }, AgentRow>(ORIGIN_OF_AGENT).get({ ref });
}

/** The agent the segment's oldest session that names a predecessor succeeds. */
function predecessorOf(db: Db, segmentOldestFirst: readonly ChainLink[]): { name: string; id: string | null } | null {
  const select = db.prepare<[string], AgentRow>(ORIGIN_OF_SESSION);
  for (const link of segmentOldestFirst) {
    for (const sessionId of link.sessionIds) {
      const ref = select.get(sessionId)?.predecessor;
      if (ref) return resolveRef(db, ref);
    }
  }
  return null;
}

function resolveRef(db: Db, ref: string): { name: string; id: string | null } {
  const row = lookupAgent(db, ref);
  if (row?.agent_id === ref && row.agent_name) return { name: row.agent_name, id: ref };
  return { name: row?.agent_name ?? ref, id: null };
}
