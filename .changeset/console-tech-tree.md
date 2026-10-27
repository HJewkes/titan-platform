---
"titan-console": minor
---

Add the read-only `#/tree` tech tree page over the `work.loops` board: a dependency DAG by default and goal swimlanes behind a Dependencies / Goal lanes toggle held in `?layout=dag|lanes`, so a deep link keeps the layout. Each node shows its state, with locked derived for a not-started node that has an unfinished dependency, its closed-in-14-days count and a ⚠ mark for high churn with no done-when progress; selecting a node lists its loops, each linking to `#/loops`. Lanes use react-ui's `laneLayout` when a release exports it and a local layout over `layeredLayout` until then.
