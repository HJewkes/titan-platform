---
"@titan-design/code-graph": patch
---

`indexPaths` reuses the snapshot that shares the most byte-identical files with the tree being indexed, not the newest one. A baseline indexed after its head, or another worktree's run in a shared graph, no longer forces every file it differs on to re-parse. `loadReuseBasis` takes an optional map of file id to content hash for this choice.
