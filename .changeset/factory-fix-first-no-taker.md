---
"@titan-design/factory": patch
---

A Shepherd wake no longer opens the owner `sh-sent-back` gate when the implementer cannot be woken (TP-1751). A retired implementer is never resumed, and a resume agent-chat refuses falls back to a successor spawn in the same wake, under the spawn load gate. A refused successor at a FIX_FIRST or NO_REPRO send-back holds the run: `sh-wake-implementer` records the refusal with `held`, and the run waits for a new head. A ci-red or conflict wake keeps its `ci-failed` gate or `not-mergeable` stop, and only agent-chat's refusal (`DispatchError`) falls back or holds. Each wake still spends one repair, so the repair budget caps them as before.
