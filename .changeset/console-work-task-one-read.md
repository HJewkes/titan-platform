---
"titan-console": patch
---

`work.task` no longer reads every initiative's done tasks to find one id, which passed active-work's read timeout and answered 500 every time. It finds an open task in the open list the stage already reads, and a done task with `task.show` in the initiative whose brief claims the id's prefix (one initiative's `task.list` on a daemon without `task.show`). A timed-out `context.graph` or `artifact.status` now marks mentions (new `mentionsDegraded`) or PR state unavailable instead of failing the page. `children` lists open children only.
