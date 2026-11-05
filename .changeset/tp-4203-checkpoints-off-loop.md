---
"@titan-design/active-work": patch
---

The session-index daemon runs its SQLite WAL checkpoints in a worker thread and no longer syncs each commit, so a slow disk's fsyncs no longer stall the daemon's event loop during a pass.
