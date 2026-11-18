---
"@titan-design/active-work": patch
---

`loops` resolves task triggers against `tasks/archive/` as well as `tasks/`, so a loop waiting on a task keeps its task-done trigger once that task is archived (TP-1015).
