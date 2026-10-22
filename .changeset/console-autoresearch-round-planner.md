---
"titan-console": minor
---

Show each round's planner on `#/autoresearch` (TP-3954). The console's run view accepts C-256 S3e's optional `rounds[].planner { agent, sessionId?, mode?, usage? }`, and each round's group in Decisions opens with a Planner row: the agent, whether it spawned fresh or resumed, and its turn's dollars, cache reads and writes and retries. A round recorded before S3e says "not recorded for this round".
