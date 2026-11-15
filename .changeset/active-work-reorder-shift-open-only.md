---
'@titan-design/active-work': patch
---

`task.reorder` now bumps only the open tasks that collide with the new priority, walking upward until a free slot. Done tasks and tasks past the first gap keep their priority and updated date, and `shifted` lists only the rewritten tasks.
