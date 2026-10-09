---
"@titan-design/factory": patch
---

Stop a Shepherd run as `update-branch-unmoved` when the update after a freeze thaw never moves the red head, as `land` does, instead of reading it as an unchanged head and spending a repair on main's old failures.
