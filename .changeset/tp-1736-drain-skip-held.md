---
"@titan-design/factory": patch
---

The restart drain no longer waits for a Shepherd run held in a merge step: it cannot merge until released, so a restart repeats nothing. `/health` lists such runs under `heldSkipped`, and the drain names them.
