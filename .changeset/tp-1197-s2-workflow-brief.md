---
"@titan-design/workflow": minor
---

`assisted` and `authorize` take an optional `brief` (hitl `GateBrief`: `summary`, `evidenceRef`, `questions?`) and store it on the gate they open, so a store with `requireBrief` accepts it. The `gate_opened` event gains an optional `summary`.
