---
"titan-console": patch
---

Accept the registry task statuses `wont-do` and `icebox` on the active-work wire, so `task.list` with status all no longer fails on them. A `wont-do` task stages as done; an `icebox` task stays live work.
