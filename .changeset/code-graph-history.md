---
"@titan-design/code-graph": minor
---

Add codewatch's git-history mining, ported unchanged, on a new `@titan-design/code-graph/history` subpath: `loadChurnEntries`, `parseChurnLog`, `resolveRenamedPath`, `entriesWithin`, `aggregateChurn`, `aggregateChurnWindows`, `loadFileFirstSeen`, `computeOwnership`, `authorLinesByPath`, `summarizeOwnership`, `computeChangeCoupling` and `couplingFor`. The API is path-based and imports nothing else from code-graph.

`indexPaths` now writes churn, recency, file age, bus factor and top-author-share metrics on file nodes by default, with codewatch's metric names and windows (30, 90 and 180 days plus the primary window, and an opt-in `lifetime`). New `IndexOptions`: `computeChurn` (set `false` to skip), `churnWindowDays`, `churnWindows` and `lifetime`. Outside git the index has no history metrics.
