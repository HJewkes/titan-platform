---
"@titan-design/agent-dispatch": minor
"@titan-design/factory": patch
---

`listAgents` now returns a promise and reads the roster through the new `execSafeAsync`, so a slow `agent ls --json` no longer blocks the caller's event loop; the Shepherd roster reader awaits it.
