import type { ReactNode } from "react";
import { Card, CardContent, HStack, Link, Pill, Typography, VStack, type PillTone } from "@titan-design/react-ui";
import type { BoardLoop } from "../../server/loop-board.js";
import { navigate } from "../router.js";
import type { NodeState, TreeNode } from "./tree-graph.js";

const STATE_TONE: Record<NodeState, PillTone> = {
  done: "success",
  "in progress": "info",
  "not started": "neutral",
  locked: "warning",
};

interface TreeNodePanelProps {
  node: TreeNode;
  state: NodeState;
  /** The board's loops; the panel lists the ones the node names. */
  loops: readonly BoardLoop[];
}

/** The selected node: its state, done-when, churn, and the loops that move it, each a way into `#/loops`. */
export function TreeNodePanel({ node, state, loops }: TreeNodePanelProps): ReactNode {
  const linked = node.loops.map((id) => loops.find((loop) => loop.id === id) ?? null);
  return (
    <Card variant="outline" testID="tree-node-panel">
      <CardContent>
        <VStack gap={3}>
          <HStack gap={2} align="center" wrap>
            <Typography variant="subtitle1" role="heading" aria-level={2}>{node.title}</Typography>
            <Pill tone={STATE_TONE[state]} leading="dot" size="sm">{state}</Pill>
            {node.churn.highChurnNoProgress ? <Pill tone="warning" variant="subtle" size="sm">⚠ high churn, no done-when progress</Pill> : null}
          </HStack>
          <Typography variant="body2" color="secondary">{`Done when: ${node.doneWhen}`}</Typography>
          <Typography variant="caption" color="secondary">{`${node.churn.closed14d} closed in 14 days · ${node.churn.openNow} open now · done-when moved: ${node.churn.doneWhenMoved}`}</Typography>
          <NodeLoops ids={node.loops} linked={linked} />
        </VStack>
      </CardContent>
    </Card>
  );
}

function NodeLoops({ ids, linked }: { ids: readonly string[]; linked: readonly (BoardLoop | null)[] }): ReactNode {
  if (ids.length === 0) return <Typography variant="body2" color="tertiary">No loops move this node.</Typography>;
  return (
    <VStack gap={2} testID="tree-node-loops">
      {linked.map((loop, at) => (
        <HStack key={ids[at]} gap={2} align="center" wrap>
          <Link color="primary" onPress={() => navigate("loops")}>{loop?.title ?? ids[at]}</Link>
          {loop ? <Typography variant="caption" color="secondary">{loop.status}</Typography> : null}
        </HStack>
      ))}
    </VStack>
  );
}
