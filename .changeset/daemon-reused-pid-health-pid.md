---
"@titan-design/daemon": patch
---

`startDaemon` now treats a reused pid as the running daemon only when the `/health` answer on the pid file's port reports that same `pid`. A 200 from a different daemon on that port no longer blocks start; the stale pid file is removed.
