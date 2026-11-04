---
"@titan-design/agent-dispatch": patch
"@titan-design/factory": patch
---

Carry `predecessor` from `agent-chat agent ls --json` through to Shepherd's roster. `AgentRow` gains an optional
`predecessor`: a string or null passes through, a missing or mistyped key stays absent and is never read as null. The
reviewer roster maps it the same way, so lineage can prove a reviewer independent once agent-chat reports the field,
and a roster without it still proves nothing.
