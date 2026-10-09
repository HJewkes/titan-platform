import path from "node:path";
import { z } from "zod";
import { EXIT } from "@titan-design/registry";
import type { SessionGraph } from "@titan-design/session-graph";
import { RELATIONS } from "@titan-design/session-read";
import { failure, type ActiveWork, type ReadResult } from "./active-work.js";
import { readCommand } from "./owner-guard.js";
import { readGraph, type Degraded, type SessionsSource } from "./sessions.js";

export interface GraphSource {
  activeWork: ActiveWork;
  sessions: SessionsSource;
}

/** `wrap` is an active-work session record: a `session:` ref whose id is no transcript uuid, so it opens no transcript. */
const NODE_KINDS = ["initiative", "task", "session", "wrap", "agent", "note", "source", "pr", "branch", "file"] as const;
type NodeKind = (typeof NODE_KINDS)[number];

/** active-work's workspace pass writes these; its `RELATIONS` is product source, so the names are copied, not imported. */
const WORKSPACE_RELATIONS = { HOLDS: "holds", MENTIONS: "mentions", SHARES_TAG: "shares_tag" } as const;
const STORED_KINDS = [
  ...Object.values(WORKSPACE_RELATIONS),
  RELATIONS.RAN, RELATIONS.SPAWNED, RELATIONS.LINKED, RELATIONS.WORKED, RELATIONS.TOUCHED, RELATIONS.EDITED_BY_HUMAN,
] as const;
/** Synthesised from `session_origin.agent_name`: the edge table holds no `agent:<name>` ref, so an agent ego would be empty. */
const RAN_AS = "ran_as";
type EdgeKind = (typeof STORED_KINDS)[number] | typeof RAN_AS;

/** Past about 150 labelled nodes a node-link view stops being legible; a busy initiative has over 1,400 neighbours. */
const EGO_CAPS = { nodes: 150, edges: 300, perKindAtDepth1: 40 } as const;
const COLLAPSIBLE = ["file", "branch"] as const;

const REF = /^([a-z_]+):(.+)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_ID = /^[A-Z][A-Z0-9]*-\d+$/;

interface EgoNode {
  ref: string;
  kind: NodeKind;
  /** The session's title where the graph has one, else the ref's tail. */
  label: string;
  depth: 0 | 1 | 2;
  /** Live edges in the graph before any cap, so the view can size or badge a node. */
  degree: number;
  /** False for a hub and for any node whose neighbours were not read. */
  expanded: boolean;
}

interface EgoEdge {
  /** Stored direction; `shares_tag` is stored both ways and sent once, lower ref first. */
  source: string;
  target: string;
  kind: EdgeKind;
  /** Null for a `context.graph` mention, which carries no time. */
  validFrom: string | null;
  /** Only when below 1. */
  confidence?: number;
  via?: string;
}

interface Collapsed {
  kind: NodeKind;
  via: EdgeKind;
  count: number;
}

export interface EgoGraph {
  center: string;
  depth: 1 | 2;
  nodes: EgoNode[];
  edges: EgoEdge[];
  /** Distinct neighbours found per kind, before caps and collapsing. */
  counts: Partial<Record<NodeKind, number>>;
  /** The cap hits; null when everything found was returned. */
  truncated: null | {
    nodeCap: number;
    edgeCap: number;
    omitted: Partial<Record<NodeKind, number>>;
    omittedEdges: number;
    collapsed: Collapsed[];
  };
  sources: { graph: "ok" | "absent" | "not_migrated" | "unreadable"; mentions: "ok" | "skipped" | "unavailable"; fallback?: "mentions" };
  degraded: Degraded | null;
}

const egoArgs = z.object({
  ref: z.string().regex(REF).describe("The center, such as task:AB-1, session:<uuid>, agent:<name> or initiative:<slug>"),
  depth: z.union([z.literal(1), z.literal(2)]).default(1),
  include: z.array(z.enum(COLLAPSIBLE)).default([]).describe("Kinds otherwise collapsed into a count"),
  limit: z
    .object({ nodes: z.number().int().positive().max(EGO_CAPS.nodes).optional(), edges: z.number().int().positive().max(EGO_CAPS.edges).optional() })
    .default({}),
});

type EgoArgs = z.infer<typeof egoArgs>;

export function graphCommands(source: GraphSource) {
  return {
    "graph.ego": readCommand({
      name: "graph.ego",
      description: "Nodes and typed edges within one or two hops of a ref, from the session graph and active-work's context.graph, capped",
      args: egoArgs,
      result: z.custom<EgoGraph>(),
      run: (args) => readEgo(source, args),
    }),
  };
}

const GRAPH_STATE = { "graph-missing": "absent", "graph-not-migrated": "not_migrated" } as const;

async function readEgo(source: GraphSource, args: EgoArgs): Promise<EgoGraph> {
  if (kindOf(args.ref) === null) throw failure(`No node kind for ${args.ref}`, EXIT.DATAERR);
  const mentions = await readMentions(source.activeWork, args.ref);
  const read = await readGraph(source.sessions.graphPath, (graph) => walk(graphReads(graph), args, mentions.edges));
  if (read.ok) return { ...read.value, sources: { graph: "ok", mentions: mentions.status }, degraded: null };
  const graph = GRAPH_STATE[read.degraded.reason as keyof typeof GRAPH_STATE] ?? "unreadable";
  const fallback = walk(null, { ...args, depth: 1 }, mentions.edges);
  return { ...fallback, sources: { graph, mentions: mentions.status, fallback: "mentions" }, degraded: read.degraded };
}

function kindOf(ref: string): NodeKind | null {
  const match = REF.exec(ref);
  if (!match) return null;
  const [, prefix = "", tail = ""] = match;
  if (prefix === "session") return UUID.test(tail) ? "session" : "wrap";
  return (NODE_KINDS as readonly string[]).includes(prefix) ? (prefix as NodeKind) : null;
}

const tailOf = (ref: string): string => ref.slice(ref.indexOf(":") + 1);

type WireReference = ReadResult<"context.graph">["references"][number];

interface Mentions {
  status: EgoGraph["sources"]["mentions"];
  edges: EgoEdge[];
}

/** `context.graph` traces task ids and session ids only; any other center has no exact-id references. */
async function readMentions(activeWork: ActiveWork, center: string): Promise<Mentions> {
  const tail = tailOf(center);
  const traceable = center.startsWith("session:") || (center.startsWith("task:") && TASK_ID.test(tail));
  if (!traceable) return { status: "skipped", edges: [] };
  try {
    const { references } = await activeWork.read("context.graph", { id: tail });
    const referrers = new Set(references.map(referrerOf));
    referrers.delete(center);
    return { status: "ok", edges: [...referrers].map((ref) => ({ source: ref, target: center, kind: "mentions", validFrom: null, via: "context.graph" })) };
  } catch {
    return { status: "unavailable", edges: [] };
  }
}

/** A session file's reference names its file, not its record id, so it gets a `wrap:` ref rather than a guessed `session:` one. */
function referrerOf({ slug, source, file }: WireReference): string {
  const stem = path.posix.basename(file).replace(/\.[^.]+$/, "");
  if (source === "task") return `task:${stem}`;
  if (source === "session") return `wrap:${slug}/${stem}`;
  return `initiative:${slug}`;
}

/** Synchronous reads over one open graph; built per request and dropped before the graph closes. */
interface GraphReads {
  links(ref: string): EgoEdge[];
  degree(ref: string): number;
  title(ref: string): string | null;
}

const placeholders = (values: readonly unknown[]): string => values.map(() => "?").join(", ");

function graphReads(graph: SessionGraph): GraphReads {
  const ranAs = ranAsReads(graph);
  const inboundKinds = STORED_KINDS.filter((kind) => kind !== WORKSPACE_RELATIONS.SHARES_TAG);
  const outbound = graph.db.prepare(`SELECT COUNT(*) AS n FROM edge WHERE source_ref = ? AND relation IN (${placeholders(STORED_KINDS)})
                                     AND t_expired IS NULL AND target_ref NOT LIKE 'agent:%'`);
  const inbound = graph.db.prepare(`SELECT COUNT(*) AS n FROM edge WHERE target_ref = ? AND relation IN (${placeholders(inboundKinds)})
                                    AND t_expired IS NULL AND source_ref NOT LIKE 'agent:%'`);
  const title = graph.db.prepare("SELECT ai_title FROM session WHERE session_id = ?");
  const count = (statement: typeof outbound, ref: string, kinds: readonly string[]) => (statement.get(ref, ...kinds) as { n: number }).n;
  return {
    links: (ref) => [...storedLinks(graph, ref), ...ranAs.links(ref)],
    degree: (ref) => count(outbound, ref, STORED_KINDS) + count(inbound, ref, inboundKinds) + ranAs.links(ref).length,
    title: (ref) => (kindOf(ref) === "session" ? ((title.get(tailOf(ref)) as { ai_title: string | null } | undefined)?.ai_title ?? null) : null),
  };
}

type EdgeRow = ReturnType<SessionGraph["edges"]["from"]>[number];

/** session-read's `agent:` refs are tool-use ids, not the agent names the console routes by, so no edge to one is passed through. */
function storedLinks(graph: SessionGraph, ref: string): EgoEdge[] {
  const ego = (row: EdgeRow) =>
    (STORED_KINDS as readonly string[]).includes(row.relation) && !row.sourceRef.startsWith("agent:") && !row.targetRef.startsWith("agent:");
  return [...graph.edges.from(ref), ...graph.edges.to(ref)].filter(ego).map(toEgoEdge);
}

function toEgoEdge(row: EdgeRow): EgoEdge {
  const swap = row.relation === WORKSPACE_RELATIONS.SHARES_TAG && row.targetRef < row.sourceRef;
  const via = [row.attrs?.via, row.attrs?.source].find((value): value is string => typeof value === "string");
  return {
    source: swap ? row.targetRef : row.sourceRef,
    target: swap ? row.sourceRef : row.targetRef,
    kind: row.relation as EdgeKind,
    validFrom: row.tValid,
    ...(row.confidence < 1 ? { confidence: row.confidence } : {}),
    ...(via ? { via } : {}),
  };
}

function ranAsReads(graph: SessionGraph): { links(ref: string): EgoEdge[] } {
  const origin = `FROM session_origin o LEFT JOIN session s ON s.session_id = o.session_id`;
  const at = "COALESCE(s.started_at, o.resolved_at) AS at";
  const bySession = graph.db.prepare(`SELECT o.agent_name AS agent, o.session_id AS session, ${at} ${origin} WHERE o.session_id = ? AND o.agent_name IS NOT NULL`);
  const byAgent = graph.db.prepare(`SELECT o.agent_name AS agent, o.session_id AS session, ${at} ${origin} WHERE o.agent_name = ?`);
  const edge = (row: { agent: string; session: string; at: string }): EgoEdge => ({ source: `agent:${row.agent}`, target: `session:${row.session}`, kind: RAN_AS, validFrom: row.at });
  return {
    links(ref) {
      const kind = kindOf(ref);
      const statement = kind === "agent" ? byAgent : kind === "session" ? bySession : null;
      return statement ? (statement.all(tailOf(ref)) as { agent: string; session: string; at: string }[]).map(edge) : [];
    },
  };
}

interface Walk {
  center: string;
  nodes: Map<string, { kind: NodeKind; depth: 0 | 1 | 2; expanded: boolean }>;
  edges: Map<string, EgoEdge>;
  seen: Set<string>;
  /** Dropped by a cap: final, so a later hop cannot bring the node back on the wrong ring or count it twice. */
  excluded: Set<string>;
  counts: Partial<Record<NodeKind, number>>;
  omitted: Partial<Record<NodeKind, number>>;
  collapsed: Map<string, Collapsed & { refs: Set<string> }>;
}

interface Candidate {
  ref: string;
  kind: NodeKind;
  newest: string;
}

/** With no graph (`reads` null) only the mentions are walked, so the answer is depth 1. */
function walk(reads: GraphReads | null, args: EgoArgs, mentions: readonly EgoEdge[]): Omit<EgoGraph, "sources" | "degraded"> {
  const center = args.ref;
  const state: Walk = { center, nodes: new Map([[center, { kind: kindOf(center)!, depth: 0, expanded: false }]]), edges: new Map(), seen: new Set([center]), excluded: new Set(), counts: {}, omitted: {}, collapsed: new Map() };
  const nodeCap = args.limit.nodes ?? EGO_CAPS.nodes;
  let frontier = [center];
  for (const hop of [1, 2] as const) {
    if (hop > args.depth) break;
    const links = [...frontier.flatMap((ref) => expand(reads, state, ref)), ...(hop === 1 ? mentions : [])];
    const candidates = admit(state, links, new Set(args.include));
    const kept = capLayer(candidates, nodeCap - state.nodes.size, hop === 1 ? EGO_CAPS.perKindAtDepth1 : Infinity);
    for (const candidate of candidates) {
      if (kept.has(candidate.ref)) state.nodes.set(candidate.ref, { kind: candidate.kind, depth: hop, expanded: false });
      else {
        state.excluded.add(candidate.ref);
        state.omitted[candidate.kind] = (state.omitted[candidate.kind] ?? 0) + 1;
      }
    }
    frontier = [...kept];
  }
  return finish(reads, state, args);
}

/** A hub is never expanded past the first hop: one initiative's `holds` alone reaches over a thousand siblings. */
const isHub = (ref: string): boolean => ref.startsWith("initiative:") || /^branch:.+\/main$/.test(ref);

function expand(reads: GraphReads | null, state: Walk, ref: string): EgoEdge[] {
  const node = state.nodes.get(ref);
  if (!reads || !node || (ref !== state.center && isHub(ref))) return [];
  node.expanded = true;
  return reads.links(ref);
}

/** Records each edge and returns the new neighbours; a collapsed kind is only counted. */
function admit(state: Walk, links: readonly EgoEdge[], include: ReadonlySet<string>): Candidate[] {
  const candidates = new Map<string, Candidate>();
  for (const link of links) {
    const other = state.nodes.has(link.source) ? link.target : link.source;
    const kind = kindOf(other);
    if (kind === null) continue;
    if (!state.seen.has(other)) {
      state.seen.add(other);
      state.counts[kind] = (state.counts[kind] ?? 0) + 1;
    }
    if ((COLLAPSIBLE as readonly string[]).includes(kind) && !include.has(kind)) {
      collapse(state, kind, link.kind, other);
      continue;
    }
    const key = `${link.source}\u0000${link.kind}\u0000${link.target}`;
    if (!state.edges.has(key)) state.edges.set(key, link);
    if (state.nodes.has(other) || state.excluded.has(other)) continue;
    const before = candidates.get(other)?.newest ?? "";
    const at = link.validFrom ?? "";
    candidates.set(other, { ref: other, kind, newest: at > before ? at : before });
  }
  return [...candidates.values()];
}

function collapse(state: Walk, kind: NodeKind, via: EdgeKind, ref: string): void {
  const key = `${kind}\u0000${via}`;
  const entry = state.collapsed.get(key) ?? { kind, via, count: 0, refs: new Set<string>() };
  entry.refs.add(ref);
  entry.count = entry.refs.size;
  state.collapsed.set(key, entry);
}

/** Round-robin by kind, newest first, so that one kind cannot crowd out the others. */
function capLayer(candidates: readonly Candidate[], budget: number, perKind: number): Set<string> {
  const newestFirst = (a: Candidate, b: Candidate) => b.newest.localeCompare(a.newest) || a.ref.localeCompare(b.ref);
  const queues = NODE_KINDS.map((kind) => candidates.filter((candidate) => candidate.kind === kind).sort(newestFirst).slice(0, perKind));
  const kept = new Set<string>();
  for (let i = 0; kept.size < budget && queues.some((queue) => i < queue.length); i++) {
    for (const queue of queues) {
      const next = queue[i];
      if (next && kept.size < budget) kept.add(next.ref);
    }
  }
  return kept;
}

function finish(reads: GraphReads | null, state: Walk, args: EgoArgs): Omit<EgoGraph, "sources" | "degraded"> {
  const edgeCap = args.limit.edges ?? EGO_CAPS.edges;
  const touchesCenter = (edge: EgoEdge) => (edge.source === state.center || edge.target === state.center ? 0 : 1);
  const inside = [...state.edges.values()].filter((edge) => state.nodes.has(edge.source) && state.nodes.has(edge.target));
  const edges = inside.sort((a, b) => touchesCenter(a) - touchesCenter(b) || (b.validFrom ?? "").localeCompare(a.validFrom ?? "")).slice(0, edgeCap);
  const nodes = [...state.nodes].map(([ref, node]): EgoNode => ({
    ref,
    ...node,
    label: reads?.title(ref) ?? tailOf(ref),
    degree: reads ? reads.degree(ref) : edges.filter((edge) => edge.source === ref || edge.target === ref).length,
  }));
  const omittedEdges = state.edges.size - edges.length;
  const collapsed = [...state.collapsed.values()].map(({ kind, via, count }) => ({ kind, via, count }));
  const hit = omittedEdges > 0 || collapsed.length > 0 || Object.keys(state.omitted).length > 0;
  const nodeCap = args.limit.nodes ?? EGO_CAPS.nodes;
  return {
    center: state.center, depth: args.depth, nodes, edges, counts: state.counts,
    truncated: hit ? { nodeCap, edgeCap, omitted: state.omitted, omittedEdges, collapsed } : null,
  };
}
