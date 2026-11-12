---
"@titan-design/active-work": patch
---

`task list --status` now accepts any status in the initiative's category registry, such as `wont-do` or `icebox`, plus `closed` for every closed status. A root with no registry still accepts `open`, `done` and `all`; an unknown status is a usage error naming the allowed values.
