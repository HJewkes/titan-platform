---
"@titan-design/factory": patch
---

Shepherd's own reviewer, fixer and successor spawns now pass a machine gate (load5, memory pressure, free memory, one admission per window) before agent-chat is asked to start them; a refused admission defers and is retried on the next poll. Limits come from `shepherd.spawnGate`, defaulting to the seat values.
