---
"@titan-design/factory": patch
---

Shepherd's wake step now gives up on a live implementer's PR that keeps failing to read. After the same give-up main-red allows a GitHub read, it returns `unhandled` naming the PR and the last error, so a permanent 404 or 401 opens the owner gate instead of polling silently. A successful read restarts the clock.
