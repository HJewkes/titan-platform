import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractProtocolEdges, getLanguageFromPath, NO_PROTOCOL_SOURCE, type GraphNode, type ProtocolEdgeResult, type ProtocolSourceFile } from "@titan-design/code-graph";
import { createLiveSource, type ReadSource } from "@titan-design/code-read";
import { callPaths, callTargets } from "./call-paths.js";
import { enrichFacts, entryRoots, factFiles, rankFiles, readingOrder } from "./centrality.js";
import { diag, type GatherDiagnostic } from "./diagnostics.js";
import { openStructureGraph, type GraphSourceOptions, type StructureGraph } from "./graph-source.js";
import { computeLevels, toFlows, type Levels } from "./levels.js";
import type { ExplainerFact } from "./schemas.js";
import { EDGE_SOURCES, StructureSchema, type CallPath, type EdgeSource, type EntryPoint, type Structure } from "./structure-schema.js";

/** Call paths start from at most this many entry files, so the search stays bounded on a large repo. */
export const MAX_CALL_ENTRIES = 3;

export interface EnrichOptions extends GraphSourceOptions {
  facts: readonly ExplainerFact[];
}

export type EnrichResult =
  | { ok: true; structure: Structure; facts: ExplainerFact[]; diagnostics: GatherDiagnostic[] }
  | { ok: false; diagnostics: GatherDiagnostic[] };

interface Context {
  graph: StructureGraph;
  options: EnrichOptions;
  read: ReadSource;
  files: GraphNode[];
  indexed: ReadonlySet<string>;
  out: GatherDiagnostic[];
}

function entryPoints(ctx: Context, facts: readonly ExplainerFact[]): EntryPoint[] {
  const readme = [...new Set(facts.filter((f) => f.kind === "entry-point").flatMap((f) => factFiles(f, ctx.indexed).resolved))];
  const roots = entryRoots(ctx.files, ctx.graph.store.listEdges(ctx.graph.snapshotId)).filter((id) => !readme.includes(id));
  return [...readme.map((path) => ({ path, from: "readme" as const })), ...roots.map((path) => ({ path, from: "root" as const }))];
}

// README entries are the review's own word on where to start; without them, the most central roots stand in.
function callEntries(ctx: Context, entries: readonly EntryPoint[]): string[] {
  const readme = entries.filter((e) => e.from === "readme").map((e) => e.path);
  if (readme.length > 0) return readme.slice(0, MAX_CALL_ENTRIES);
  const ranks = rankFiles(ctx.read, ctx.graph.snapshotId, entries.map((e) => e.path));
  const byRank = ranks.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
  return byRank.slice(0, MAX_CALL_ENTRIES).map((rank) => rank.path);
}

async function protocolSources(ctx: Context): Promise<ProtocolSourceFile[]> {
  const scripts = ctx.files.filter((file) => getLanguageFromPath(file.id) === "typescript");
  const texts = await Promise.all(scripts.map((file) => readFile(join(ctx.options.clonePath, file.id), "utf8").catch(() => undefined)));
  return scripts.flatMap((file, i) => (texts[i] === undefined ? [] : [{ path: file.id, text: texts[i] }]));
}

function protocolDiagnostics(result: ProtocolEdgeResult): GatherDiagnostic[] {
  return result.diagnostics
    .filter((finding) => finding.code === NO_PROTOCOL_SOURCE)
    .map((finding) => diag("W-NO-PROTOCOL", `${NO_PROTOCOL_SOURCE}: ${finding.message}`));
}

function fileResolver(ctx: Context): (id: string) => string {
  const parent = new Map(ctx.graph.store.listNodes(ctx.graph.snapshotId, { includeSymbols: true }).map((n) => [n.id, n.parentId]));
  return (id) => (parent.get(id) !== undefined && !ctx.indexed.has(id) ? parent.get(id)! : id);
}

function withFlows(ctx: Context, levels: Levels, paths: CallPath[]): { levels: Levels; paths: CallPath[] } {
  const found = paths.flatMap((p) => (p.path === null ? [] : [{ id: `flow:${p.fact_id}`, title: `${p.entry} to ${p.target}`, nodes: p.path }]));
  const { flows, unprojected } = toFlows(levels.map, found, fileResolver(ctx));
  for (const miss of unprojected) {
    ctx.out.push(diag("W-NO-CALL-PATH", `${miss.flowId} has no map route at level ${miss.level}: ${miss.reason}`, miss.flowId.slice("flow:".length)));
  }
  const ids = new Set(flows.map((flow) => flow.id));
  const wired = paths.map((p) => (ids.has(`flow:${p.fact_id}`) ? { ...p, flow_id: `flow:${p.fact_id}` } : p));
  return { levels: { ...levels, map: { ...levels.map, flows } }, paths: wired };
}

function edgeSources(levels: Levels, paths: readonly CallPath[], protocol: ProtocolEdgeResult): EdgeSource[] {
  const used = new Set<string>(levels.map.edges.map((edge) => edge.edgeSource));
  if (paths.some((p) => p.path !== null)) used.add("call");
  if (protocol.edges.length > 0) used.add("protocol");
  return EDGE_SOURCES.filter((source) => used.has(source));
}

async function mapLevels(ctx: Context, focusFile: string | undefined, paths: CallPath[]) {
  const protocol = extractProtocolEdges(await protocolSources(ctx));
  ctx.out.push(...protocolDiagnostics(protocol));
  const graph = { snapshotId: ctx.graph.snapshotId, nodes: ctx.files, edges: ctx.graph.store.listEdges(ctx.graph.snapshotId) };
  const levels = await computeLevels({ graph, protocolEdges: protocol.edges, ...(focusFile === undefined ? {} : { focusFile }) });
  const wired = withFlows(ctx, levels, paths);
  return { ...wired, edgeSources: edgeSources(wired.levels, wired.paths, protocol) };
}

async function buildStructure(ctx: Context): Promise<EnrichResult> {
  const { graph, options, read, indexed, out } = ctx;
  const cited = options.facts.flatMap((fact) => factFiles(fact, indexed).resolved);
  const ranks = rankFiles(read, graph.snapshotId, cited);
  const enriched = enrichFacts(options.facts, new Map(ranks.map((r) => [r.path, r])), indexed);
  out.push(...enriched.diagnostics);
  const order = graph.files === 0 ? [] : readingOrder(read, graph.snapshotId);
  const entries = entryPoints(ctx, enriched.facts);
  const symbols = graph.store.listNodes(graph.snapshotId, { includeSymbols: true });
  const calls = callPaths(graph.store, graph.snapshotId, callEntries(ctx, entries), callTargets(enriched.facts, symbols, indexed));
  out.push(...calls.diagnostics);
  const mapped = await mapLevels(ctx, order[0]?.path, calls.paths);
  const structure = StructureSchema.parse({
    schema: "structure/v1",
    snapshot: { id: graph.snapshotId, commit: options.pin, source: graph.source, files: graph.files },
    levels: mapped.levels,
    centrality: ranks,
    reading_order: order,
    entry_points: entries,
    call_paths: mapped.paths,
    edge_sources: mapped.edgeSources,
  });
  return { ok: true, structure, facts: enriched.facts, diagnostics: out };
}

/**
 * The S1 structure stage: opens the code graph at the review pin and returns a `structure/v1`
 * (architecture levels, centrality, reading order, entry points, call paths as map flows) with
 * every fact carrying its centrality, reading rank, module and shape hint. An index that cannot be
 * opened or built is `E-INDEX` and no structure.
 */
export async function enrichStructure(options: EnrichOptions): Promise<EnrichResult> {
  const opened = await openStructureGraph(options);
  if (!opened.ok) return opened;
  const { graph } = opened;
  try {
    const files = graph.store.listNodes(graph.snapshotId).filter((node) => node.kind === "file");
    const read = createLiveSource({ openStore: () => graph.store });
    const indexed = new Set(files.map((file) => file.id));
    return await buildStructure({ graph, options, read, files, indexed, out: [...opened.diagnostics] });
  } finally {
    await graph.close();
  }
}
