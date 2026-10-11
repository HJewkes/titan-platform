---
"@titan-design/agent-dispatch": minor
---

Add `askHuman`, `readAnswers` and `dismissAsk` over agent-chat's `ask`, `answers` and `dismiss` verbs, so a process that is not a Claude session can put a question on the human queue and read the answer back later (CC-169). `execSafeAsync` takes an optional `input` for the child's stdin.
