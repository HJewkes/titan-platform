---
"@titan-design/tool-guard": patch
---

Deny an agent's Bash command when any decoded word carries `TITAN_TOOL_GUARD_BYPASS` other than as a plain `$NAME` read, and when a prefix, `env` or declaration assigns a name the reader cannot spell out, as `bash.config.bypass-env`. Commands that only name it (`unset`, `grep`, `rg`, `echo` with a literal word) still pass. A shell startup file and the MCP `agent_spawn` path are not covered here.
