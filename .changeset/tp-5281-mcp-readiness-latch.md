---
"@titan-design/daemon": patch
---

An `/mcp` request on a daemon that inherits its listen socket now waits for the pid file to be written, as every other route already did. Before, the MCP handler was spliced in ahead of the readiness latch and answered during startup.
