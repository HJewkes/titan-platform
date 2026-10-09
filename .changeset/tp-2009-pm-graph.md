---
"@titan-design/pm": minor
---

Add `taskTree(tasks, rootId)`, the subtree under a task by `parent` edges with each node's status and estimate, and `criticalPath(tasks, { deliverable })`, the total float of each open task over its `dep` edges and the longest open chain by estimate. A dep outside the set counts as satisfied, an unestimated task has duration 0, and dep cycles are reported rather than thrown. Until the category registry is wired in, `done` and `wont-do` count as closed.
