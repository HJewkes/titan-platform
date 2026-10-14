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
| `routeOf(edge)` | the typed route a layout attached to `edge.attrs.route`, or undefined |
| `routeToPathD(route)` | an SVG path `d` (`M x y L x y …`) through a route's points |
| `labelBoxSizing(labels, metrics)` | box sizes that fit each label plus padding and a fixed body, for a collapsed level laid out at the size it is shown |
| `packageOf(fileId)` | the package id a file belongs to, the id `collapseToPackages` gives it |
| `ELK_LAYOUT_OPTIONS`, `FOCUS_LAYOUT_OPTIONS`, `COMPOUND_LAYOUT_OPTIONS` | the ELK option sets for the package, focus and nested views |
| `GraphInput`, `GroupOf`, `LabelMetrics`, `LaidOutNode`, `LaidOutGroup`, `LayoutResult`, `CompoundLayoutResult`, `NodeSizing` | types |

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
see Fixed positions. If ELK throws or places nothing, both layouts fall back to a grid.

The cost is that a group box is sized for everything inside it, so at the package level a
box is mostly empty space. To show a collapsed level at its own size, lay that level out on
its own: `computeLayout(collapseToPackages(input), labelBoxSizing(labels, metrics))`. Each box
then fits its label, and since ELK keeps boxes apart, no two labels overlap. The boxes of that
layout are not the boxes of the compound one, so a view that moves between the two levels
moves between two layouts.

## Fixed positions

ELK layered does not keep node positions given as input. Its interactive strategies read
them only as ordering hints and then place the nodes again. ELK's `fixed` algorithm keeps
positions but routes no edges, and elkjs does not bundle the libavoid router.
