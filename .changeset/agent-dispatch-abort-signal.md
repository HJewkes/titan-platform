---
"@titan-design/agent-dispatch": minor
---

`listAgents`, `listAgentLineage`, `retire`, `messageAgent` and `parkAgent` take an optional trailing `AbortSignal`. Aborting it kills the `agent-chat` child and rejects with `DispatchError`, as `askHuman` already does.
