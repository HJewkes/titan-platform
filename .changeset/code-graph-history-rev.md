---
"@titan-design/code-graph": minor
---

Read churn, recency and ownership up to a revision. `loadChurnEntries` takes an optional `rev` to walk `git log` from instead of HEAD, and an optional `untilEpoch` that finite windows end at instead of the wall clock. `loadFileFirstSeen` takes the same optional `rev`. `HistoryMetricsOptions` gains `rev`, which goes with `nowEpoch`.

An index from `gitTreeSource` now records history metrics. Before, it recorded none. `churn_{w}`, `recency_{w}`, `file_age_days`, `bus_factor_{w}` and `top_author_share_{w}` come from history up to the source's commit, and their windows end at that commit's time. Commits made after it do not count. A working-tree index without a source still reads HEAD, with windows ending at the wall clock, so its output is unchanged.
