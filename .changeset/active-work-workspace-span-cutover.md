---
"@titan-design/active-work": minor
---

Cut workspace search over to `workspace_span`. The workspace pass writes the new table, backfills a graph that still holds workspace spans in `search_span` (resuming after an interrupted pass), and flips readers once a pass finishes by deleting the legacy rows in one transaction. `miner refresh --reset-workspace-spans` rebuilds the table from the files, `miner status` reports `workspaceBackfill`, and term frequency counts both tables.
