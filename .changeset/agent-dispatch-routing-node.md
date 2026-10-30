---
"@titan-design/agent-dispatch": minor
---

Add `readSpawnFacts` and `readRouteTable` to `./routing/node`. `readSpawnFacts` reads a spawn's routing facts from an active-work root: estimate, done_when and tags (with a `kind:` field folded in) from the task file, and owns and points from the plan's `burndown-slices` block, falling back to the spawn's own owns. It marks a task id found in two initiatives as ambiguous. `readRouteTable` gives the table with its `shape-v1@<sha8>` id and re-reads the file only when its mtime or size changes.
