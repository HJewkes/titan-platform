---
"@titan-design/active-work": patch
---

`active-work mcp restart` now spawns its detached successor before it stops the old daemon, so a restart issued through MCP, which runs inside the daemon it stops, still leaves a daemon listening. The successor waits for the old process to exit. A restart whose successor never listens fails with a message to start the daemon manually.
