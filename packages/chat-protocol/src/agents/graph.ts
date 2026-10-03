import { layoutSpawnTree } from "./layout.js";
import { foldAgentRecords } from "./lifecycle.js";
import { historyWindowOf } from "./roster.js";
import { isPeerName, nodeActivity } from "./spawn-tree.js";
import type { AgentGraph, AgentGraphEdge, AgentRosterEntry, BrokerEvent } from "./types.js";

/** Directed sends; a broadcast has no single recipient, so it draws no edge. */
const MESSAGE_KINDS = new Set(["message", "question", "answer", "notice", "approval_request"]);

export interface AgentGraphInput {
  events: readonly BrokerEvent[];
  historyLimit: number;
  now: number;
  /** Joins graph nodes to roster rows by name. */
  roster?: readonly AgentRosterEntry[];
}

/** The spawn tree as nodes, plus spawned-by and message edges with counts. */
export function foldAgentGraph(input: AgentGraphInput): AgentGraph {
  const layout = layoutSpawnTree(input.events);
  const activity = nodeActivity(input.events);
  const ids = nodeIds(input, layout.nodes.map(({ name }) => name));
  const nodes = [...layout.nodes]
    .sort((a, b) => a.depth - b.depth || a.row - b.row)
    .map(({ name, parent, depth, row }) => ({
      id: ids.node(name),
      name,
      rosterId: ids.roster(name),
      parent,
      depth,
      row,
      activity: activity.get(name) ?? null,
    }));
  const edges = [...spawnEdges(input.events, layout.edges), ...messageEdges(input.events, new Set(layout.byName.keys()))];
  return {
    nodes,
    edges: edges.map((edge) => ({ ...edge, from: ids.node(edge.from), to: ids.node(edge.to) })),
    history: historyWindowOf(input.events, input.historyLimit),
    generatedAt: input.now,
  };
}

/** The roster id when a row matches, else the newest spawn's agent id, else a name-scoped id. */
function nodeIds(input: AgentGraphInput, names: readonly string[]) {
  const rosterIds = new Map((input.roster ?? []).map((entry) => [entry.name, entry.id]));
  const agentIds = new Map([...foldAgentRecords(input.events).values()].map((record) => [record.name, record.agentId]));
  const roster = (name: string): string | null => rosterIds.get(name) ?? null;
  const byName = new Map(names.map((name) => [name, roster(name) ?? agentIds.get(name) ?? `name:${name}`]));
  return { roster, node: (name: string): string => byName.get(name) ?? `name:${name}` };
}

/** One edge per tree edge; `count` is how many times the window saw that spawn. */
function spawnEdges(events: readonly BrokerEvent[], treeEdges: readonly { from: string; to: string }[]): AgentGraphEdge[] {
  const tally = edgeTally("spawned");
  const tree = new Set(treeEdges.map(({ from, to }) => `${from}\u0000${to}`));
  for (const event of events) {
    if (event.kind !== "agent_spawned") continue;
    const child = event.meta["target"] ?? event.meta["name"] ?? "";
    if (tree.has(`${event.from}\u0000${child}`)) tally.add(event.from, child, event.at);
  }
  return tally.edges();
}

/** One edge per ordered sender and recipient pair, keyed by name until ids are assigned. */
function messageEdges(events: readonly BrokerEvent[], names: ReadonlySet<string>): AgentGraphEdge[] {
  const tally = edgeTally("message");
  const seen = new Set<string>();
  for (const event of events) {
    if (!MESSAGE_KINDS.has(event.kind)) continue;
    const to = event.meta["target"] ?? "";
    const key = `${event.msgId}\u0000${to}`;
    if (!isPeerName(to) || to === event.from || seen.has(key) || !names.has(to) || !names.has(event.from)) continue;
    seen.add(key);
    tally.add(event.from, to, event.at);
  }
  return tally.edges();
}

interface EdgeTally {
  add(from: string, to: string, at: number): void;
  edges(): AgentGraphEdge[];
}

function edgeTally(kind: AgentGraphEdge["kind"]): EdgeTally {
  const byPair = new Map<string, AgentGraphEdge>();
  const add = (from: string, to: string, at: number): void => {
    const edge = byPair.get(`${from}\u0000${to}`);
    if (!edge) {
      byPair.set(`${from}\u0000${to}`, { kind, from, to, count: 1, lastAt: at });
      return;
    }
    edge.count += 1;
    edge.lastAt = Math.max(edge.lastAt, at);
  };
  const edges = () => [...byPair.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return { add, edges };
}
