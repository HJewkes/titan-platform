---
"@titan-design/agent-dispatch": minor
---

`retire`, `messageAgent`, `resumeAgent` and `dispatchToAgentChat` are async and return Promises, so a long-lived caller's event loop stays free while the agent-chat child answers; refusals now reject instead of throw. `execSafeAsync` takes an optional trailing `cwd`. The unexported `runAgentChat` is gone.
