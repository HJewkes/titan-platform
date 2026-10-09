---
"titan-console": minor
---

Read task edges and deliverables through `@titan-design/pm`. `work.tasks` and `work.task` rows carry `parent`, `dep` and `deliverables`, read with pm's `readEdges`, so a task with only edge tags and one with edge fields read the same. The blocked-by-dependency stage rule takes its deps from those edges rather than from `dep:` tags. `work.task` also lists the task's `children` and joins each deliverable id to its record from active-work's `deliverable.list`, with `null` for an unknown id and `deliverablesDegraded` set when the daemon has no such read.
