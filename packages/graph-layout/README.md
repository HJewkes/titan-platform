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
| `computeCompoundLayout(input, sizing, groupOf, options?)` | nested layout; `groupOf` names each node's ancestor groups, outermost first |
| `routeOf(edge)` | the typed route a layout attached to `edge.attrs.route`, or undefined |
| `ELK_LAYOUT_OPTIONS`, `FOCUS_LAYOUT_OPTIONS`, `COMPOUND_LAYOUT_OPTIONS` | the ELK option sets for the package, focus and nested views |
| `GraphInput`, `GroupOf`, `LaidOutNode`, `LayoutResult`, `NodeSizing` | types |

A package is the segment after `packages/` in a file id, or else the id's first segment.

## Determinism

Both layouts sort nodes by id and edges by `(srcId, dstId, kind)` before ELK sees them, and
round every centre and route point to 0.5 px. The same graph listed in any order gives the
same coordinates, and the result lists nodes and edges in that sorted order. ELK layered
breaks ties by input order, so without the sort a fan-out's siblings swap places.

## Coordinates

Node `x` and `y` are box centres in the root frame. Routes sit on `edge.attrs.route`, also in
the root frame. ELK reports compound children relative to their parent and an edge's route
relative to its endpoints' lowest common ancestor group; `computeCompoundLayout` adds both
offsets back. If ELK throws or places nothing, both layouts fall back to a grid.

## Fixed positions

ELK layered does not keep node positions given as input. Its interactive strategies read
them only as ordering hints and then place the nodes again. ELK's `fixed` algorithm keeps
positions but routes no edges, and elkjs does not bundle the libavoid router.
