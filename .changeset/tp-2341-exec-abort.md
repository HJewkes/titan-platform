---
"@titan-design/agent-dispatch": minor
---

`execSafeAsync`, `runAgentChatAsync`, `askHuman`, `readAnswers` and `dismissAsk` take an optional `AbortSignal`. Aborting it kills the child and rejects with the new `ExecAbortedError`. A signal that has already aborted starts no child.
