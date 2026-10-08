---
"@titan-design/factory": patch
---

A Shepherd wake no longer opens the owner `sh-sent-back` gate when the implementer cannot be woken (TP-1751). A retired implementer is never resumed, and a resume agent-chat refuses falls back to a successor spawn in the same wake, under the spawn load gate. A refused successor holds the run: `sh-wake-implementer` records the refusal with `held`, and the run waits for a new head. Each wake still spends one repair, so the repair budget caps them as before.
