---
"@titan-design/factory": patch
---

A Shepherd wake no longer opens the owner `sh-sent-back` gate when the implementer cannot be woken (TP-1751). A retired implementer is never resumed, and a resume agent-chat refuses falls back to a successor spawn in the same wake, under the spawn load gate. A refused successor at a FIX_FIRST or NO_REPRO send-back holds the run: `sh-wake-implementer` records the refusal with `held`, then the repo's seat is told through `sh-exit-notice` and the run waits for a new head, or, when no notice is sent, `sh-sent-back` opens naming the refusal. The watch row's next action and the timeline's wake entry (a new optional `held` field) name the refusal. A ci-red or conflict wake keeps its `ci-failed` gate or `not-mergeable` stop, and only agent-chat's refusal (`DispatchError`) falls back or holds. Each wake still spends one repair, so the repair budget caps them as before.
