---
"@titan-design/factory": patch
---

`shepherd register --task <ID>` with no initiative now resolves the ID through the active-work task index, or exits with a usage error naming `--task <initiative>/<ID>` when no single initiative owns it. A bare ID could never be closed at cleanup.
