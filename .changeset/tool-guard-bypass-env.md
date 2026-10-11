---
"@titan-design/tool-guard": patch
---

Deny an agent's Bash command that sets or exports `TITAN_TOOL_GUARD_BYPASS` in any shape (inline env, `export`, `env`, a bare assignment, a run-time value or name), as `bash.config.bypass-env`. Only a session launched by the owner with the variable set keeps owner authority.
