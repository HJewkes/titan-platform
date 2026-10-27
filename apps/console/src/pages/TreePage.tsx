import { useMemo, useState, type ReactNode } from "react";
import { Alert, EmptyState, NetworkGraph, Spinner, Tab, TabList, Tabs, Typography, VStack, useMeasuredWidth, type GraphItemRef } from "@titan-design/react-ui";
import type { LoopBoard } from "../../server/loop-board.js";
import { useQuery } from "../data/rpc.js";
import { open, type Route } from "../router.js";
import { TreeNodePanel } from "./TreeNodePanel.js";
import { EDGE_KINDS, LAYOUT_MODES, layoutModeOf, NODE_KINDS, nodeStateOf, treeGraph, treeLayout, type TreeData, type TreeLayoutMode } from "./tree-graph.js";

const FALLBACK_WIDTH = 360;
const GRAPH_HEIGHT = 480;
const MODE_LABELS: Record<TreeLayoutMode, string> = { dag: "Dependencies", lanes: "Goal lanes" };

/** The tech tree, read-only: every node by state, as a dependency DAG or in goal swimlanes, with the layout held in `?layout=`. */
export function TreePage({ route }: { route: Route }): ReactNode {
  const read = useQuery("work.loops");
  if (read.status === "loading") return <Spinner size="sm" label="Loading the tech tree" />;
  if (read.data === undefined) return <Alert status="error" message={`Could not load the tech tree: ${read.error.message}`} />;
  const { board, unavailable } = read.data;
  if (board === null) return <Alert status="info" testID="tree-unavailable" message={`The tech tree is not served by this host's active-work daemon: ${unavailable ?? "unknown reason"}.`} />;
  if (board.tree === null) return <EmptyState title="No tech tree is imported yet." />;
  return <TreeView tree={board.tree} loops={board.loops} mode={layoutModeOf(route.query)} />;
}

interface TreeViewProps {
  tree: TreeData;
  loops: LoopBoard["loops"];
  mode: TreeLayoutMode;
}

function TreeView({ tree, loops, mode }: TreeViewProps): ReactNode {
  const [selection, setSelection] = useState<GraphItemRef | null>(null);
  const byId = useMemo(() => new Map(tree.nodes.map((node) => [node.id, node])), [tree]);
  const selected = selection?.type === "node" ? byId.get(selection.id) : undefined;
  return (
    <VStack gap={4}>
      <Typography variant="body1" color="secondary">Read-only. A not-started node with an unfinished dependency is locked; ⚠ marks high churn with no done-when progress.</Typography>
      <Tabs variant="soft-rounded" value={LAYOUT_MODES.indexOf(mode)} onValueChange={(index) => open({ view: "tree", query: `layout=${LAYOUT_MODES[index] ?? "dag"}` })}>
        <TabList>
          {LAYOUT_MODES.map((key) => (
            <Tab key={key}>{MODE_LABELS[key]}</Tab>
          ))}
        </TabList>
      </Tabs>
      <TreePlot tree={tree} loops={loops} mode={mode} onSelect={setSelection} />
      {selected ? <TreeNodePanel node={selected} state={nodeStateOf(selected, byId)} loops={loops} /> : <Typography variant="body2" color="tertiary">Select a node to see its loops.</Typography>}
    </VStack>
  );
}

function TreePlot({ tree, loops, mode, onSelect }: TreeViewProps & { onSelect: (selection: GraphItemRef | null) => void }): ReactNode {
  const { width, onLayout } = useMeasuredWidth();
  const graph = useMemo(() => treeGraph(tree, loops), [tree, loops]);
  const layout = useMemo(() => treeLayout(mode, tree.goals), [mode, tree.goals]);
  return (
    <VStack onLayout={onLayout} testID={`tree-graph-${mode}`}>
      <NetworkGraph
        accessibilityLabel={mode === "lanes" ? "Tech tree in goal lanes" : "Tech tree dependencies"}
        nodes={graph.nodes}
        edges={graph.edges}
        layout={layout}
        nodeKinds={NODE_KINDS}
        edgeKinds={EDGE_KINDS}
        showLegend
        width={width ?? FALLBACK_WIDTH}
        height={GRAPH_HEIGHT}
        onSelectionChange={onSelect}
      />
    </VStack>
  );
}
