# @titan-design/graph-layout

## 0.2.0

### Minor Changes

- 538c0f7: code-graph adds `extractProtocolEdges`, which reads HTTP routes, SSE streams and MCP tools from source text and links each to the files that call it, plus a `NO_PROTOCOL_SOURCE` diagnostic when a repo declares none. graph-layout's `emitRepoMap` takes those edges as `protocolEdges` and draws one labelled one-way `protocol` arrow per container pair, or labels the container import arrows "imports only" when there is no arrow to draw.

### Patch Changes

- Updated dependencies [59b9c44]
- Updated dependencies [67eec51]
- Updated dependencies [31bb9da]
- Updated dependencies [7492819]
- Updated dependencies [54d25fc]
- Updated dependencies [c89daa1]
- Updated dependencies [7a34209]
- Updated dependencies [7792f8b]
- Updated dependencies [ae8141d]
- Updated dependencies [9b42150]
- Updated dependencies [fe806c0]
- Updated dependencies [538c0f7]
- Updated dependencies [565913d]
- Updated dependencies [30d9837]
  - @titan-design/code-graph@0.19.0

## 0.1.0

### Minor Changes

- dcc6957: Add `@titan-design/graph-layout`, extracted from codewatch's renderer: `collapseToPackages`, `collapseToDirectories`, `focusPackage`, `packagesInSnapshot`, `computeLayout`, `computeCompoundLayout`, the ELK option sets and `GroupOf`. Both layouts sort their input by id and round coordinates to 0.5 px, so any input order gives the same layout.
- 9009fb3: `computeCompoundLayout` returns every group's absolute box on `groups` and routes edges whose ends are group ids in the same ELK pass, so every level of a map reads one layout. Add `routeToPathD(route)`, the `LaidOutGroup` and `CompoundLayoutResult` types, and pin `elkjs` to 0.10.2 (TP-2810).
- 3cc0993: `packageOf` gives each `products/<name>` and `apps/<name>` its own package instead of one `products` or `apps` package, so `collapseToPackages`, `focusPackage` and `packagesInSnapshot` split them too. Export `packageOf`, and add `labelBoxSizing(labels, metrics)`, which sizes boxes to their labels so a collapsed level can be laid out at the size it is shown (TP-2816).
- 9010664: Add `placePills(scene, pins, config)`: a top-left box for each pin's pill beside its anchor box, inside the frame above a caller-given keep-out line, clear of every listed obstacle and every earlier pill, in rank-then-id order. A pill with no clear spot is returned in `dropped` (TP-2976).
- e1b38f5: Add `emitRepoMap`, which lays a file-level snapshot out as one `repo-map/v1` map: package, directory and file boxes in one frame, routed edges at every level with weights, `+N more` pruning, 44 px label sizing and a sha over the inputs and the elkjs version. It rejects instead of falling back to a grid. Add `computeCompoundLayoutStrict`, the compound layout without the fallback, with optional group header bands.

### Patch Changes

- Updated dependencies [178ad42]
- Updated dependencies [c33b063]
- Updated dependencies [a8be5f4]
- Updated dependencies [b5d304f]
- Updated dependencies [7a3800a]
- Updated dependencies [5716d14]
- Updated dependencies [d084831]
- Updated dependencies [03a8d23]
- Updated dependencies [5cd4f1b]
- Updated dependencies [adaf424]
  - @titan-design/code-graph@0.18.0
