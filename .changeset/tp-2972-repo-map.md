---
"@titan-design/graph-layout": minor
---

Add `emitRepoMap`, which lays a file-level snapshot out as one `repo-map/v1` map: package, directory and file boxes in one frame, routed edges at every level with weights, `+N more` pruning, 44 px label sizing and a sha over the inputs and the elkjs version. It rejects instead of falling back to a grid. Add `computeCompoundLayoutStrict`, the compound layout without the fallback, with optional group header bands.
