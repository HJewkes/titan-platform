---
"@titan-design/daemon": patch
---

Destroy lingering sockets on shutdown so SIGTERM always terminates the process.

`server.close` resolves only once every open connection ends, and an MCP or `/events`
client holds one for its whole session, so a daemon could outlive SIGTERM indefinitely
and leave its port held against a restart. `close` now sweeps idle connections at once
and destroys the rest after `shutdownGraceMs` (default 2000).
