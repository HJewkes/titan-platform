---
"@titan-design/active-work": patch
---

`active-work open` parses each task file once: `archiveStaleTasks` returns the tasks it loaded (minus the archived ones) and the bootstrap reuses them instead of reading the task directory again.
