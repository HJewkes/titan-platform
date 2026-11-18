---
"@titan-design/active-work": patch
---

A lock that is lost while held (for example after a laptop sleeps past the stale window) no longer throws from proper-lockfile's timer and kills the daemon. `withFileLock` and `withRefreshLock` now fail the holder's operation with a `LockCompromisedError` (exit 75) instead (TP-1013).
