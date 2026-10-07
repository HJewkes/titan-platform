---
"@titan-design/session-miner": patch
---

Read `MINER_VERSION` from package.json, so `--version`, the daemon's `/health` and the MCP server report the package version instead of a stale `0.1.0`.
