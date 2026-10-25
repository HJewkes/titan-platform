---
"@titan-design/active-work": patch
---

A full pass reads the sessions with unfinished turns in pages of 1000 turns and yields after each page, so resuming a killed pass no longer holds the daemon's event loop on one large query.
