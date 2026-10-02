---
"@titan-design/code-graph": minor
---

Add `diffFootprints(store, { fromSnapshotId, toSnapshotId })`: the symbols whose footprint differs between two snapshots, as `added`, `removed` or `changed` with reasons `signature`, `consumers`, `coupling` or `renamed`, plus a rollup to declaring files. From-side ids follow the alias chain, and a symbol under a moved file follows its file, so a move with an unchanged footprint reports `["renamed"]` alone.
