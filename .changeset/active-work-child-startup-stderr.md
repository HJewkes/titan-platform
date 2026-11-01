---
"@titan-design/active-work": patch
---

Name a spawned server's startup death in the daemon and MCP integration tests: the failure now carries the child's exit status and stderr instead of "never became healthy" after 15 s or a bare "Connection closed".
