import * as reactUi from "@titan-design/react-ui";
import { layeredLayout, type GraphEdge, type GraphEdgeKind, type GraphGroup, type GraphGroupRegion, type GraphKind, type GraphLayout, type GraphLayoutInput, type GraphNode, type GraphPoint } from "@titan-design/react-ui";
import type { BoardLoop, LoopBoard } from "../../server/loop-board.js";

export type TreeData = NonNullable<LoopBoard["tree"]>;
export type TreeNode = TreeData["nodes"][number];
/** The ledger's three states plus `locked`, which the page derives. */
export type NodeState = TreeNode["state"] | "locked";
export type TreeLayoutMode = "dag" | "lanes";

export const LAYOUT_MODES: readonly TreeLayoutMode[] = ["dag", "lanes"];

export const NODE_KINDS: GraphKind[] = [
  { id: "done", label: "Done" },
  { id: "in progress", label: "In progress" },
  { id: "not started", label: "Not started" },
  { id: "locked", label: "Locked" },
];

export const EDGE_KINDS: GraphEdgeKind[] = [{ id: "unlocks", label: "unlocks" }];

/** `?layout=lanes` opens the swimlanes; anything else is the dependency DAG. */
export function layoutModeOf(query: string | undefined): TreeLayoutMode {
  return new URLSearchParams(query ?? "").get("layout") === "lanes" ? "lanes" : "dag";
}

/** A not-started node waits on its dependencies; one still unfinished, or unknown, locks it. */
export function nodeStateOf(node: TreeNode, byId: ReadonlyMap<string, TreeNode>): NodeState {
  if (node.state !== "not started") return node.state;
  return node.dependsOn.some((dep) => byId.get(dep)?.state !== "done") ? "locked" : node.state;
}

/** The churn mark: high churn with no done-when progress reads as a warning before the title. */
function nodeLabel(node: TreeNode): string {
  const mark = node.churn.highChurnNoProgress ? "⚠ " : "";
  return `${mark}${node.title} · ${node.churn.closed14d} closed in 14d`;
}

function nodeDescription(node: TreeNode, loopTitles: ReadonlyMap<string, string>): string {
  const titles = node.loops.map((id) => loopTitles.get(id) ?? id);
  return titles.length === 0 ? `Done when: ${node.doneWhen}` : `Done when: ${node.doneWhen}. Loops: ${titles.join("; ")}`;
}

/** The tree as NetworkGraph input: one node per tree node grouped by goal, one edge from each prerequisite to the node that needs it. */
export function treeGraph(tree: TreeData, loops: readonly BoardLoop[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  const loopTitles = new Map(loops.map((loop) => [loop.id, loop.title]));
  const nodes = tree.nodes.map((node) => ({ id: node.id, label: nodeLabel(node), kind: nodeStateOf(node, byId), group: node.goal, description: nodeDescription(node, loopTitles) }));
  const edges = tree.nodes.flatMap((node) => node.dependsOn.map((dep) => ({ source: dep, target: node.id, kind: "unlocks" })));
  return { nodes, edges };
}

const LANE_HEADER = 36;
const ROW_HEIGHT = 64;
const OTHER_LANE: GraphGroup = { id: "", label: "Other" };

interface Band {
  lane: GraphGroup;
  /** Node ids by column x, each column in the DAG's row order. */
  columns: Map<number, string[]>;
}

function bandsOf(lanes: readonly GraphGroup[], nodes: readonly GraphNode[], dag: Readonly<Record<string, GraphPoint>>): Band[] {
  const bands = new Map<string, Band>([...lanes, OTHER_LANE].map((lane) => [lane.id, { lane, columns: new Map() }]));
  const byRow = nodes.filter((node) => dag[node.id] !== undefined).sort((a, b) => dag[a.id]!.y - dag[b.id]!.y || a.id.localeCompare(b.id));
  for (const node of byRow) {
    const band = bands.get(node.group ?? "") ?? bands.get(OTHER_LANE.id)!;
    const x = dag[node.id]!.x;
    band.columns.set(x, [...(band.columns.get(x) ?? []), node.id]);
  }
  return [...bands.values()].filter((band) => band.columns.size > 0);
}

/** Columns from the layered layout, one horizontal box per lane, nodes stacked in rows inside it. */
function lanesOverLayered(lanes: readonly GraphGroup[]): GraphLayout {
  const dag = layeredLayout();
  const compute = (input: GraphLayoutInput) => {
    const base = dag.compute(input);
    const positions: Record<string, GraphPoint> = {};
    const groups: GraphGroupRegion[] = [];
    let top = 0;
    for (const { lane, columns } of bandsOf(lanes, input.nodes, base.positions)) {
      const rows = Math.max(...[...columns.values()].map((column) => column.length));
      const height = LANE_HEADER + rows * ROW_HEIGHT;
      for (const [x, ids] of columns) ids.forEach((id, row) => (positions[id] = { x, y: top + LANE_HEADER + (row + 0.5) * ROW_HEIGHT }));
      const nodeIds = [...columns.values()].flat();
      groups.push({ id: lane.id || "other", label: lane.label, nodeIds, cx: base.width / 2, cy: top + height / 2, radius: 0, variant: "box", box: { x: 0, y: top, width: base.width, height } });
      top += height;
    }
    const order = groups.flatMap((group) => group.nodeIds);
    // The DAG's routes would run between its own rows, not the lanes'.
    return { ...base, positions, order, height: Math.max(top, input.height), groups, routes: {} };
  };
  return { key: `lanes-over-layered:${lanes.map((lane) => lane.id).join(",")}`, compute };
}

type LaneLayout = (options: { lanes: GraphGroup[] }) => GraphLayout;

const isLaneLayout = (value: unknown): value is LaneLayout => typeof value === "function";

/** react-ui's own laneLayout once a release exports it (TD-1034); until then, lanes drawn over layeredLayout here. */
export function treeLayout(mode: TreeLayoutMode, goals: TreeData["goals"]): GraphLayout {
  if (mode === "dag") return layeredLayout();
  const lanes = goals.map((goal) => ({ id: goal.id, label: goal.title }));
  const released = (reactUi as Record<string, unknown>).laneLayout;
  return isLaneLayout(released) ? released({ lanes }) : lanesOverLayered(lanes);
}
