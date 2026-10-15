# @titan-design/graph-layout

Level collapses and ELK layered layouts over a `@titan-design/code-graph` snapshot. Collapse
a file-level graph to the altitude a picture needs, then lay it out flat or as nested group
boxes with orthogonal edge routes.

Tier 2 of the titan-platform DAG. Depends on `code-graph` (types, `edgeWeight`,
`resolveBarrelEdges`) and `elkjs`. The `package-layers` rule in `.codewatch/check.json`
enforces the tier in CI.

## Exports

| Export | Does |
| --- | --- |
| `collapseToPackages(input)` | one node per package, one weighted edge per ordered cross-package pair |
| `collapseToDirectories(input, { resolve })` | one node per source directory; by default runs on barrel-resolved edges |
| `focusPackage(input, pkg, { includeTests })` | one package's files in full, other packages as stub nodes |
| `packagesInSnapshot(input)` | sorted package names that own at least one file |
| `computeLayout(input, sizing?, options?)` | flat ELK layered layout with orthogonal routes |
| `computeCompoundLayout(input, sizing, groupOf, options?)` | nested layout; `groupOf` names each node's ancestor groups, outermost first. Also returns `groups` (every group's box) and routes edges whose ends are group ids |
| `computeCompoundLayoutStrict(input, spec)` | the nested layout without the grid fallback: rejects when ELK throws or places nothing. `spec.groupHeaders` reserves a header band per group (top padding and minimum width) |
| `emitRepoMap(input, options?)` | one `repo-map/v1` map of a file-level snapshot: package boxes (level 1) hold directory boxes (level 2) hold file boxes (level 3), with routed edges at every level, a `+N more` box past `maxFilesPerBox` per directory, 44 px label sizing and a sha. Rejects instead of falling back to a grid |
| `ELK_VERSION`, `MAP_LABEL_METRICS` | the pinned elkjs version that every map sha covers, and the default map label metrics |
| `routeOf(edge)` | the typed route a layout attached to `edge.attrs.route`, or undefined |
| `routeToPathD(route)` | an SVG path `d` (`M x y L x y …`) through a route's points |
| `labelBoxSizing(labels, metrics)` | box sizes that fit each label plus padding and a fixed body, for a collapsed level laid out at the size it is shown |
| `placePills(scene, pins, config)` | a top-left box for each pin's pill beside its anchor, inside the frame above `config.keepOut`, clear of `scene.obstacles` and earlier pills; pills with no clear spot come back in `dropped`. Placed in `rank` then id order, so pin input order does not matter |
| `packageOf(fileId)` | the package id a file belongs to, the id `collapseToPackages` gives it |
| `ELK_LAYOUT_OPTIONS`, `FOCUS_LAYOUT_OPTIONS`, `COMPOUND_LAYOUT_OPTIONS` | the ELK option sets for the package, focus and nested views |
| `MapLayout`, `MapNode`, `MapEdge`, `MapBox`, `MapPoint`, `MapLevel`, `MapEdgeSource`, `MapFlow`, `MapFlowHop`, `MapCardRef` | the `repo-map/v1` data, field for field the shape titan-design's map painter reads |
| `CompoundLayoutSpec`, `RepoMapOptions`, `GraphInput`, `GroupOf`, `LabelMetrics`, `LaidOutNode`, `LaidOutGroup`, `LayoutResult`, `CompoundLayoutResult`, `NodeSizing`, `PillScene`, `PinSpec`, `PillConfig`, `PillPlacement`, `PlacedPill`, `DroppedPill`, `Rect`, `SceneRect` | types |

A package is the segment after `packages/` in a file id, `products/<name>` or `apps/<name>` for a
file inside one, or else the id's first segment. Products and apps keep their root in the id, so
one cannot collide with a package of the same name.

## Determinism

Both layouts sort nodes by id and edges by `(srcId, dstId, kind)` before ELK sees them, and
round every centre and route point to 0.5 px. The same graph listed in any order gives the
same coordinates, and the result lists nodes, groups and edges in that sorted order. `elkjs` is
pinned to an exact version, because a minor release can move every coordinate. ELK layered
breaks ties by input order, so without the sort a fan-out's siblings swap places.

## Coordinates

Node and group `x` and `y` are box centres in the root frame. Routes sit on `edge.attrs.route`, also in
the root frame. ELK reports compound children relative to their parent and an edge's route
relative to its endpoints' lowest common ancestor group; `computeCompoundLayout` adds both
offsets back.

## Every level in one pass

An edge given to `computeCompoundLayout` may name a group id as either end, for example a
package-to-package edge from `collapseToPackages` with ids that match `groupOf`. ELK routes it
between the group boxes in the same pass that places the files, so a map's package view and
file view read one layout and the boxes never move between them. A second pass cannot do this:
see Fixed positions. If ELK throws or places nothing, both layouts fall back to a grid;
`computeCompoundLayoutStrict` and `emitRepoMap` reject instead.

The cost is that a group box is sized for everything inside it, so at the package level a
box is mostly empty space. To show a collapsed level at its own size, lay that level out on
its own: `computeLayout(collapseToPackages(input), labelBoxSizing(labels, metrics))`. Each box
then fits its label, and since ELK keeps boxes apart, no two labels overlap. The boxes of that
layout are not the boxes of the compound one, so a view that moves between the two levels
moves between two layouts.

## The repo map

`emitRepoMap` writes the one-frame map an animated architecture diagram zooms around. It
nests every source file in a `pkg:<package>` box and a `dir:<directory>` box, adds the
`collapseToPackages` and `collapseToDirectories` edges between those boxes, and lays
everything out in one `computeCompoundLayoutStrict` pass. So package edges (level 1),
directory edges (level 2) and file edges (level 3) are all routed, and a box never moves
between levels. A file edge's `edgeSource` is `call` only when every edge folded into it is a
`calls` edge.

A directory shows at most `maxFilesPerBox` boxes (default 6). Past that it keeps the files
with the highest summed edge weight, ties broken by id, and folds the rest into one
`more:<directory>` box labelled `+N more`, with `hidden: N`. Edges of pruned files are not
drawn at level 3 but still count in the level 1 and 2 weights.

Boxes are sized for 44 px labels in a face whose advance is 0.501 em (`MAP_LABEL_METRICS`).
A group reserves a header band of its label's size. elkjs 0.10.2 reads a nested group's
minimum size as (height, width) when the direction is vertical, so the strict layout hands it
over swapped there.

The sha covers every box, edge, label metric and ELK option, plus `ELK_VERSION`, all sorted,
so the same snapshot in any order gives the same sha. The map rejects, rather than drawing a
grid, when ELK throws, leaves a box unplaced or an edge unrouted, or a collapse edge names no
group box, because every consumer downstream reads the routes.

## Fixed positions

ELK layered does not keep node positions given as input. Its interactive strategies read
them only as ordering hints and then place the nodes again. ELK's `fixed` algorithm keeps
positions but routes no edges, and elkjs does not bundle the libavoid router.
