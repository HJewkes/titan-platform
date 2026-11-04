---
"@titan-design/active-work": patch
---

A full pass gathers the sessions with unfinished turns a page at a time and yields between pages, so a pass resuming many unfinished turns no longer holds the daemon's event loop for one long query.
