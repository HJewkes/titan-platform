---
"@titan-design/active-work": minor
---

Add `active-work spawn <name> <profile>`, a CLI-only command that spawns an agent through `agent-chat agent spawn` as the caller (via `spawnAsCaller` from `@titan-design/agent-dispatch`). It takes `--host`, `--account <name|least-used>` (default `least-used`), `--brief-file` or `--brief-stdin`, `--cwd`, `--briefing`, `--surface` and `--remote-control`, prints agent-chat's account readings and spawn line verbatim, and exits 1 with the readings on a refusal. It is not registered as an MCP tool, because the MCP daemon would reach the broker as the human.
