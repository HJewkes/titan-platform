---
"@titan-design/factory": patch
---

`service check`, `service status` and the deploy and rollback health waits probe `/health` with a 6 s per-request timeout instead of the daemon's 500 ms default, so a loaded serve is no longer reported as a stale pid or a failed restart. Each wait keeps its nominal wall-time budget.
