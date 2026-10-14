/** ELK options for a flat package-level graph. */
export const ELK_LAYOUT_OPTIONS: Record<string, string> = {
  algorithm: "layered",
  "elk.direction": "DOWN",
  // Generous inter-layer channels so fan-out and skip edges route between
  // layers instead of grazing the boxes.
  "elk.layered.spacing.nodeNodeBetweenLayers": "110",
  "elk.spacing.nodeNode": "55",
  "elk.layered.spacing.edgeNodeBetweenLayers": "24",
  "elk.spacing.edgeNode": "24",
  "elk.spacing.edgeEdge": "16",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.padding": "[top=24,left=24,bottom=24,right=24]",
};

/**
 * ELK options for the within-package focus view. A focused package is usually
 * few layers but wide, so this trades spacing for compactness: tighter
 * intra-layer spacing plus left compaction squeezes horizontal slack out, while
 * the inter-layer channels stay wide enough for orthogonal routing. Layered
 * wrapping does not help here, because it cuts the layer sequence, not its width.
 */
export const FOCUS_LAYOUT_OPTIONS: Record<string, string> = {
  algorithm: "layered",
  "elk.direction": "DOWN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "90",
  "elk.spacing.nodeNode": "38",
  "elk.layered.spacing.edgeNodeBetweenLayers": "20",
  "elk.spacing.edgeNode": "20",
  "elk.spacing.edgeEdge": "12",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.compaction.postCompaction.strategy": "LEFT",
  "elk.padding": "[top=24,left=24,bottom=24,right=24]",
};

/** ELK options for a nested graph: `INCLUDE_CHILDREN` lays the whole hierarchy out in one pass. */
export const COMPOUND_LAYOUT_OPTIONS: Record<string, string> = {
  algorithm: "layered",
  "elk.direction": "DOWN",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.spacing.nodeNodeBetweenLayers": "90",
  "elk.spacing.nodeNode": "40",
  "elk.layered.spacing.edgeNodeBetweenLayers": "20",
  "elk.spacing.edgeNode": "20",
  "elk.spacing.edgeEdge": "12",
  "elk.padding": "[top=30,left=20,bottom=20,right=20]",
};
