---
"titan-console": patch
---

Add the `work.tasks` and `work.task` commands. `work.tasks` lists open tasks across every initiative, each with a derived stage from titan-design's task-stage vocabulary, the rule that produced it, a reason naming the evidence, and a `stageGuessed` flag when no evidence was found. Review comes from an open pull request, in-progress from a live worktree or a branch not merged into the main line, and blocked from open `dep:` tags and dependency clauses, holds, and open slices. Git and GitHub are read once per repository and cached for a minute. `work.task` returns one task with its notes, done_when, mentions, artifacts with PR state and the sessions linked through `session_origin.task_ids`; an unknown id is not found. `work.portfolio` rows now carry each brief's `taskPrefix`.
