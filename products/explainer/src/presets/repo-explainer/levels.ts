import { projectCallPath, type GraphNode, type ProtocolEdge } from "@titan-design/code-graph";
import { emitRepoMap, focusPackage, packageOf, type GraphInput, type MapFlow, type MapFlowHop, type MapLayout } from "@titan-design/graph-layout";
import type { BoxSummary, FocusGraph } from "./structure-schema.js";

const PACKAGE_LEVEL = 1;
const DIRECTORY_LEVEL = 2;
const FILE_LEVEL = 3;

export interface Levels {
  map: MapLayout;
  packages: BoxSummary[];
  directories: BoxSummary[];
  focus?: FocusGraph;
}

interface LevelsInput {
  graph: GraphInput;
  protocolEdges: readonly ProtocolEdge[];
  /** The most central file; its package becomes the focus graph. */
  focusFile?: string;
}

// Code-unit order, not localeCompare, so output cannot vary with the host locale.
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function fileWeights(map: MapLayout): Map<string, number> {
  const parent = new Map(map.nodes.map((node) => [node.id, node.parentId]));
  const files = new Map<string, number>();
  for (const leaf of map.nodes.filter((node) => node.level === FILE_LEVEL)) {
    for (let at = leaf.parentId; at !== undefined; at = parent.get(at)) files.set(at, (files.get(at) ?? 0) + (leaf.hidden ?? 1));
  }
  return files;
}

/** One level's boxes with file and edge counts; no raw edges, which stay in the map. */
function summarize(map: MapLayout, level: number): BoxSummary[] {
  const files = fileWeights(map);
  const edges = map.edges.filter((edge) => edge.level === level);
  return map.nodes
    .filter((node) => node.level === level)
    .map((node) => ({
      id: node.id,
      label: node.label,
      files: files.get(node.id) ?? 0,
      edges_in: edges.filter((edge) => edge.target === node.id).length,
      edges_out: edges.filter((edge) => edge.source === node.id).length,
    }));
}

function focusOf(graph: GraphInput, focusFile: string): FocusGraph {
  const pkg = packageOf(focusFile);
  const focused = focusPackage(graph, pkg);
  const ids = (kind: GraphNode["kind"]) => focused.nodes.filter((node) => node.kind === kind).map((node) => node.id).sort(byText);
  return { package: pkg, files: ids("file"), neighbours: ids("package"), edges: focused.edges.length };
}

/** The repo map at package, directory and file level, its summaries, and the focus graph of the most central package. */
export async function computeLevels({ graph, protocolEdges, focusFile }: LevelsInput): Promise<Levels> {
  const map = await emitRepoMap(graph, { protocolEdges });
  return {
    map,
    packages: summarize(map, PACKAGE_LEVEL),
    directories: summarize(map, DIRECTORY_LEVEL),
    ...(focusFile === undefined ? {} : { focus: focusOf(graph, focusFile) }),
  };
}

interface FlowPath {
  id: string;
  title: string;
  /** Graph node ids, symbols or files. */
  nodes: readonly string[];
}

interface Unprojected {
  flowId: string;
  level: number;
  reason: string;
}

const dirOf = (fileId: string): string => (fileId.includes("/") ? fileId.slice(0, fileId.lastIndexOf("/")) : fileId);

// repo-map/v1 names its boxes `pkg:<package>`, `dir:<directory>` and the file id, or `more:<directory>` once pruned.
function boxOf(map: MapLayout, level: number): (fileId: string) => string {
  const shown = new Set(map.nodes.filter((node) => node.level === FILE_LEVEL).map((node) => node.id));
  if (level === PACKAGE_LEVEL) return (fileId) => `pkg:${packageOf(fileId)}`;
  if (level === DIRECTORY_LEVEL) return (fileId) => `dir:${dirOf(fileId)}`;
  return (fileId) => (shown.has(fileId) ? fileId : `more:${dirOf(fileId)}`);
}

function projectAt(map: MapLayout, level: number, nodes: readonly string[], fileOf: (id: string) => string): MapFlowHop[] {
  const box = boxOf(map, level);
  const edges = map.edges.filter((edge) => edge.level === level);
  const source = new Map(edges.map((edge) => [edge.id, edge.edgeSource]));
  return projectCallPath(nodes, (id) => box(fileOf(id)), edges).map((hop, index) => ({
    step: index + 1,
    edgeId: hop.edgeId,
    from: hop.from,
    to: hop.to,
    edgeSource: source.get(hop.edgeId)!,
  }));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One path as a flow: hops at the finest level it projects onto, the coarser levels folded into `projected`. */
function toFlow(map: MapLayout, path: FlowPath, fileOf: (id: string) => string, unprojected: Unprojected[]): MapFlow | undefined {
  const byLevel = new Map<number, MapFlowHop[]>();
  for (const level of [FILE_LEVEL, DIRECTORY_LEVEL, PACKAGE_LEVEL]) {
    try {
      byLevel.set(level, projectAt(map, level, path.nodes, fileOf));
    } catch (error) {
      unprojected.push({ flowId: path.id, level, reason: message(error) });
    }
  }
  const [finest, ...coarser] = [...byLevel];
  if (finest === undefined) return undefined;
  const projected = Object.fromEntries(coarser.map(([level, hops]) => [level, hops.map(({ from, to }) => ({ from, to }))]));
  return { id: path.id, title: path.title, hops: finest[1], projected };
}

/**
 * Projects node paths onto the map's levels with code-graph's `projectCallPath`, so every hop names
 * a real map edge. A level with no edge for some hop (a pruned box, a call with no import) is left
 * out of that flow and reported, rather than failing the map.
 */
export function toFlows(map: MapLayout, paths: readonly FlowPath[], fileOf: (id: string) => string): { flows: MapFlow[]; unprojected: Unprojected[] } {
  const unprojected: Unprojected[] = [];
  const flows = paths.flatMap((path) => toFlow(map, path, fileOf, unprojected) ?? []);
  return { flows, unprojected };
}
