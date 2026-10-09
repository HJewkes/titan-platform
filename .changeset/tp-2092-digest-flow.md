---
"@titan-design/factory": minor
---

The factory digest gains a Flow section: task-to-merge p50 (from a task's `created` date to its Shepherd run's merge, for runs merged in the window) and merges per implementer slot-hour (merged runs over implementer, implementer-lite and bd-implementer hours from the broker roster, each span clipped to the window). A run with no task, or whose task cannot be read, counts as missing and is never imputed (TP-2092).
