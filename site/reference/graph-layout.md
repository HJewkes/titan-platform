# graph-layout

**Tier 2 · domain.** Depends on [`code-graph`](/reference/code-graph) and `elkjs`.

```sh
npm install @titan-design/graph-layout
```

## The problem it solves

A file-level code graph is too dense to draw. A picture of it needs two steps: collapse the
graph to the level the reader cares about (packages, directories, or one package against its
neighbours), then place boxes and route edges so they do not cross the boxes. Both steps
lived privately inside codewatch's renderer, so a second product had to copy them.

The primitive is **a level collapse plus an ELK layered layout that is a function of the
graph alone**. Inputs are sorted by id before ELK runs and coordinates are rounded to
0.5 px, so the same graph listed in any order lays out the same way.

## When to reach for it

- You draw a code-graph snapshot as boxes and edges, flat or with nested group boxes.
- You need the layout to be reproducible: a cached picture, a diffable artifact, or a video
  frame that must not shift between renders.

Use [`code-graph`](/reference/code-graph) for the graph itself and
[`code-read`](/reference/code-read)'s `hierarchy.get` for rolled-up values per tree depth.

## Example

Verified against 0.0.0.

```ts
import { collapseToPackages, computeLayout } from "@titan-design/graph-layout";

const packages = collapseToPackages({
  snapshotId: 1,
  nodes: [
    { id: "packages/web/src/app.ts", kind: "file", name: "app.ts" },
    { id: "packages/api/src/server.ts", kind: "file", name: "server.ts" },
  ],
  edges: [{ srcId: "packages/web/src/app.ts", dstId: "packages/api/src/server.ts", kind: "imports" }],
});
const { nodes, edges } = await computeLayout(packages);
// nodes: [{ id: "api", x, y, width: 180, height: 48, ... }, { id: "web", ... }]
// edges[0].attrs.route: the orthogonal route from web to api, in the root frame
```

For nested boxes, pass a `GroupOf` that names each node's ancestor groups, outermost first:

```ts
import { computeCompoundLayout } from "@titan-design/graph-layout";

const layout = await computeCompoundLayout(fileGraph, null, (n) => [`pkg:${n.id.split("/")[1]}`]);
// layout.groups: [{ id: "pkg:api", x, y, width, height }, ...], each box around its files
```

Edges may name a group id as either end. Such an edge is routed between the group boxes in
the same pass, so a package view drawn over the file layout needs no second layout:

```ts
import { computeCompoundLayout, routeOf, routeToPathD } from "@titan-design/graph-layout";

const pkgEdge = { srcId: "pkg:web", dstId: "pkg:api", kind: "imports" };
const layout = await computeCompoundLayout(
  { ...fileGraph, edges: [...fileGraph.edges, pkgEdge] },
  null,
  (n) => [`pkg:${n.id.split("/")[1]}`],
);
const trunk = layout.edges.find((e) => e.srcId === "pkg:web" && e.dstId === "pkg:api")!;
const d = routeToPathD(routeOf(trunk) ?? []); // "M x y L x y …", web's border to api's
```

## What it deliberately does not do

- No rendering. It returns coordinates and routes; drawing them is the product's job.
- No layout with fixed node positions. ELK layered places every node itself. Its
  interactive strategies read input positions only as ordering hints, ELK's `fixed`
  algorithm keeps positions but routes no edges, and elkjs does not bundle libavoid.
- No pruning or labels. Box sizes come from the caller's `sizing` map, defaulting to
  180 x 48.

## Gotchas

- Results list nodes and edges sorted by id, not in input order.
- `x` and `y` are box centres, not top-left corners, for nodes and group boxes alike.
- A group-endpoint edge attaches only when its id equals one `groupOf` returns; any other
  edge whose ends are not node or group ids is dropped from the layout.
- `elkjs` is pinned to an exact version: a minor release can move every coordinate.
- A route is keyed by its `(srcId, dstId)` pair, so two edges of different kinds between
  the same pair share one route.
- When ELK throws or places nothing, the layout falls back to a grid rather than throwing.
- The `packages/<name>` rule for a file's package is fixed; other layouts group by the id's
  first segment.

## Where it came from

Extracted from codewatch's `@codewatch/render` (the collapse functions, `computeLayout`, the
compound layout and its ELK option sets) for a second product that draws repository maps.
The extraction added the id sort and the 0.5 px rounding. codewatch moves onto this package
in a later change.
