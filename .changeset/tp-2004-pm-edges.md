---
"@titan-design/pm": minor
---

Add `parent` (one task id) and `dep` (unique id list) to `TaskSchema`. Add `readEdges(task)`, which reads those fields and, during the migration window only, falls back to `epic:`/`parent:` and `dep:`/`blocked-by:` tags. Add `checkEdges(tasks, change)`, a pure check that returns `unknown-id` and `cycle` errors and a non-fatal `cross-initiative-parent` warning.
