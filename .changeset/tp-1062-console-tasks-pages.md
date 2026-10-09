---
"titan-console": patch
---

Add the Tasks pages. `#/tasks` lists open tasks from `work.tasks` grouped by derived stage, with stage, initiative, severity and text filters kept in the query string and a caption on each guessed stage. `#/tasks/<id>` shows one task from `work.task` with its pull request state, mentions and linked sessions as links. Both ship on react-ui 0.20.0's `Table` and `Badge` until the console pins a react-ui that exports `TaskTable` stage rows and `TaskStagePill`.
