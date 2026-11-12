---
"@titan-design/factory": patch
---

A reviewer name reused across sessions now reads its newest session. `latestSession` took the last roster row, but agent-chat lists the roster newest-first, so it read the oldest session and could miss the verdict the current one wrote. It now takes the first row with a started session.
