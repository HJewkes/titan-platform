---
"@titan-design/factory": patch
---

Shepherd now replaces a live implementer that starts no turn after a wake and its message fallback. It retires the agent, never forced, and starts a successor in successor mode with the same failure context, through the existing spawn gate. The seat is told only when the successor also starts no turn, when agent-chat refuses the retire (a tree with unpushed work), or when no successor could start (an advisory repo or one with no checkout).
