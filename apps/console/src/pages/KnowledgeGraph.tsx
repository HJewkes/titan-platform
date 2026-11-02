import type { ReactNode } from "react";
import {
  Alert,
  Caption,
  EmptyState,
  NetworkGraph,
  Spinner,
  VStack,
  egoLayout,
  refGraphKinds,
  useMeasuredWidth,
  type GraphEdgeKind,
  type GraphItemRef,
  type GraphKind,
} from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";
import { followRef } from "./homeLinks.js";

type Ego = ConsoleCommands["graph.ego"]["result"];

const EGO_DEPTH = 2;
const FALLBACK_WIDTH = 360;
const MIN_HEIGHT = 320;
const MAX_HEIGHT = 560;

/** graph.ego's kinds beyond react-ui's ref vocabulary borrow the colour of the ref they stand for. */
function nodeKinds(): GraphKind[] {
  const kinds = refGraphKinds();
  const colorOf = (id: string) => kinds.find((kind) => kind.id === id)?.color;
  return [...kinds, { id: "source", label: "Source", color: colorOf("note") }, { id: "wrap", label: "Session log", color: colorOf("session") }, { id: "branch", label: "Branch" }];
}

const NODE_KINDS = nodeKinds();

const EDGE_KINDS: GraphEdgeKind[] = [
  { id: "holds", label: "holds" },
  { id: "mentions", label: "mentions", stroke: "dashed" },
  { id: "shares_tag", label: "shares a tag" },
  { id: "ran", label: "ran" },
  { id: "ran_as", label: "ran as" },
  { id: "spawned", label: "spawned" },
  { id: "linked", label: "linked" },
  { id: "worked", label: "worked on" },
  { id: "touched", label: "touched" },
  { id: "edited_by_human", label: "edited by a human" },
];

/** The Graph tab: every ref `graph.ego` takes can be a center, so a task or session works as well as a note. */
export function KnowledgeGraph({ center }: { center: string | null }): ReactNode {
  if (!center) return <EmptyState title="Pick a record to see its neighbours." />;
  return <EgoRead center={center} />;
}

function EgoRead({ center }: { center: string }): ReactNode {
  const ego = useQuery("graph.ego", { ref: center, depth: EGO_DEPTH, include: [], limit: {} });
  if (ego.status === "loading") return <Spinner size="sm" label="Loading graph" />;
  if (ego.data === undefined) return <Alert status="error" message={`Could not load graph: ${ego.error.message}`} />;
  return <EgoView ego={ego.data} />;
}

/** Counts are distinct neighbours found before the caps and the file and branch collapsing. */
const foundNeighbours = (ego: Ego): number => Object.values(ego.counts).reduce((sum, count) => sum + count, 0);

function EgoView({ ego }: { ego: Ego }): ReactNode {
  const shown = ego.nodes.length - 1;
  return (
    <VStack gap={2}>
      {ego.sources.fallback === "mentions" ? <Alert status="warning" size="compact" message="Session links are unavailable; showing mention links only." /> : null}
      {ego.sources.mentions === "unavailable" ? <Alert status="warning" size="compact" message="Mentions did not load in time; showing session links only." /> : null}
      {ego.truncated ? <Caption>{`Showing ${shown} of ${foundNeighbours(ego)} neighbours.`}</Caption> : null}
      {shown > 0 ? <EgoPlot ego={ego} /> : <EmptyState title="No linked records." description="Pick a record to see its neighbours." />}
    </VStack>
  );
}

function openNode(selection: GraphItemRef | null): void {
  if (selection?.type === "node") followRef(selection.id);
}

function EgoPlot({ ego }: { ego: Ego }): ReactNode {
  const { width, onLayout } = useMeasuredWidth();
  const plotWidth = width ?? FALLBACK_WIDTH;
  return (
    <VStack onLayout={onLayout}>
      <NetworkGraph
        accessibilityLabel={`Records linked to ${ego.center}`}
        nodes={ego.nodes.map((node) => ({ id: node.ref, label: node.label, kind: node.kind, description: node.ref }))}
        edges={ego.edges.map((edge) => ({ source: edge.source, target: edge.target, kind: edge.kind }))}
        layout={egoLayout({ focusId: ego.center, hops: ego.depth })}
        nodeKinds={NODE_KINDS.filter((kind) => ego.nodes.some((node) => node.kind === kind.id))}
        edgeKinds={EDGE_KINDS.filter((kind) => ego.edges.some((edge) => edge.kind === kind.id))}
        showLegend
        width={plotWidth}
        height={Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, plotWidth))}
        onSelectionChange={openNode}
      />
    </VStack>
  );
}
