---
"@titan-design/active-work": patch
---

Count `tasks/archive` when allocating a task id, so archiving the highest id no longer lets the next `task add` reissue it.
