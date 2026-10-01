---
"@titan-design/factory": minor
---

`service install --mcp` accepts `--claude-config-dir <dir>` (repeatable) and registers the MCP endpoint in each dir, printing the config file written. A path that is not a directory fails before anything is written.
