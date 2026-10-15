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

A group box is sized for everything inside it, so the package view of a compound layout is
mostly empty boxes. To show the package level at its own size, lay the collapsed graph out
alone with boxes sized for their labels. No two labels overlap, because each sits inside a box
ELK keeps clear of the others. These boxes are not the compound layout's boxes, so a view that
zooms from one level to the other moves between two layouts:

```ts
import { collapseToPackages, computeLayout, labelBoxSizing } from "@titan-design/graph-layout";

const packages = collapseToPackages(fileGraph);
const labels = new Map(packages.nodes.map((n) => [n.id, n.name]));
// Monospace labels at 28 units: each box is the label's width plus 10 on each side, and 64 tall.
const sizing = labelBoxSizing(labels, { fontSize: 28, charWidth: 0.6, padding: 10, bodyHeight: 16 });
const level1 = await computeLayout(packages, sizing);
```

A pin is a short pill of text beside one box. `placePills` places each pill outside its box,
inside the visible frame above a keep-out band, and clear of every label you list and every
pill placed before it. It reads geometry only, so a product can run it at build time and hand
the boxes to a painter. A pill with no clear spot comes back in `dropped`, never drawn over
something:

```ts
import { placePills } from "@titan-design/graph-layout";

const { placed, dropped } = placePills(
  {
    frame: { x: 0, y: 0, width: 1200, height: 675 },
    anchors: [{ id: "api", rect: { x: 520, y: 160, width: 160, height: 60 } }],
    obstacles: [{ id: "web->api", rect: { x: 300, y: 176, width: 200, height: 28 } }],
  },
  [{ id: "p1", anchor: "api", width: 140, height: 32 }],
  { gap: 8, keepOut: 0.83 },
);
// placed: [{ id: "p1", anchor: "api", rect: { x: 530, y: 228, width: 140, height: 32 }, candidate: "below0" }]
```

For an animated architecture diagram, `emitRepoMap` writes the whole map at once: package
boxes hold directory boxes, which hold file boxes, and the edges at all three levels are routed
in one pass. The result is `repo-map/v1` data that titan-design's map painter reads as is:

```ts
import { emitRepoMap } from "@titan-design/graph-layout";

const map = await emitRepoMap(fileGraph, { maxFilesPerBox: 6 });
// map.nodes: [{ id: "pkg:api", level: 1, box: { x, y, w, h } }, { id: "dir:packages/api/src", level: 2, parentId: "pkg:api", ... }, ...]
// map.edges: [{ id: "pkg:web->pkg:api", level: 1, weight: 3, edgeSource: "import", route: [[x, y], ...] }, ...]
// map.sha: the same for the same snapshot in any order, and it covers the elkjs version
```

## What it deliberately does not do

- No rendering. It returns coordinates and routes; drawing them is the product's job.
- No layout with fixed node positions. ELK layered places every node itself. Its
  interactive strategies read input positions only as ordering hints, ELK's `fixed`
  algorithm keeps positions but routes no edges, and elkjs does not bundle libavoid.
- No pruning or label text outside the repo map. Box sizes come from the caller's `sizing`
  map, defaulting to 180 x 48, and a pill's size comes from its `PinSpec`. `emitRepoMap`
  alone prunes (`+N more`) and sizes boxes for 44 px labels.
- No caption policy. `placePills` takes the keep-out line as `config.keepOut`; the product
  owns the number.

## Gotchas

- Results list nodes and edges sorted by id, not in input order.
- `x` and `y` are box centres, not top-left corners, for nodes and group boxes alike. A
  `Rect` in `placePills` is the other way round: `x` and `y` are its top-left corner.
- `placePills` places in `rank` order, then by id, whatever order the pins come in. Give a
  later-cued pin a higher rank so earlier pins keep the spots nearest their boxes.
- A group-endpoint edge attaches only when its id equals one `groupOf` returns; any other
  edge whose ends are not node or group ids is dropped from the layout.
- `elkjs` is pinned to an exact version: a minor release can move every coordinate.
- A route is keyed by its `(srcId, dstId)` pair, so two edges of different kinds between
  the same pair share one route.
- When ELK throws or places nothing, `computeLayout` and `computeCompoundLayout` fall back to a
  grid rather than throwing. `computeCompoundLayoutStrict` and `emitRepoMap` reject, because a
  grid has no routes.
- The rule for a file's package is fixed (`packageOf`): `packages/<name>` gives `<name>`,
  `products/<name>` and `apps/<name>` keep their root, and any other path groups by its first
  segment.

## Where it came from

Extracted from codewatch's `@codewatch/render` (the collapse functions, `computeLayout`, the
compound layout and its ELK option sets) for a second product that draws repository maps.
The extraction added the id sort and the 0.5 px rounding. codewatch moves onto this package
in a later change.
