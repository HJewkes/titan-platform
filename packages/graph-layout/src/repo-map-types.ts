// The repo-map/v1 layout as plain data. It mirrors titan-design's map contract field for
// field, so the JSON this package writes is what that painter reads, with no import between them.

/** An axis-aligned box in the layout's one absolute frame, in px; `x` and `y` are its top-left. */
export interface MapBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A point in the layout frame, in px. */
export type MapPoint = readonly [number, number];

/** Where an edge's evidence comes from. `traced` is inferred and paints dashed. */
export type MapEdgeSource = "import" | "call" | "protocol" | "traced";

/** One zoom level. Level 0 is the coarsest; a node's children sit one or more levels deeper. */
export interface MapLevel {
  id: number;
  name: string;
}

/** A box on the map. Its box lies inside its parent's box, so every level shares one frame. */
export interface MapNode {
  id: string;
  label: string;
  sublabel?: string;
  level: number;
  parentId?: string;
  kind?: string;
  box: MapBox;
  /** An overflow node stands for this many pruned siblings. */
  hidden?: number;
}

/** A directed edge. `route` is the absolute polyline from the source's border to the target's. */
export interface MapEdge {
  id: string;
  source: string;
  target: string;
  level: number;
  kind?: string;
  edgeSource: MapEdgeSource;
  label?: string;
  weight?: number;
  route?: readonly MapPoint[];
}

/** One numbered step of a flow, along one edge. */
export interface MapFlowHop {
  step: number;
  edgeId: string;
  from: string;
  to: string;
  edgeSource: MapEdgeSource;
}

/** A path through the map, such as one request. `projected` folds the hops to a coarser level. */
export interface MapFlow {
  id: string;
  title?: string;
  hops: readonly MapFlowHop[];
  projected?: Readonly<Record<number, readonly { from: string; to: string }[]>>;
}

/** A pop-out card anchored to a node. */
export interface MapCardRef {
  id: string;
  kind: string;
  anchor: string;
}

/** The precomputed layout: one frame, every level, every route. */
export interface MapLayout {
  version: "repo-map/v1";
  width: number;
  height: number;
  levels: readonly MapLevel[];
  nodes: readonly MapNode[];
  edges: readonly MapEdge[];
  flows: readonly MapFlow[];
  cards: readonly MapCardRef[];
  sha: string;
}
