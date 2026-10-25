---
"@titan-design/active-work": patch
---

Session-index passes roll up one session per transaction and yield after each, so a delta pass's rollup and a full pass's resume of unfinished turns no longer hold the daemon's event loop for seconds.
