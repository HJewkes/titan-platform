---
"@titan-design/factory": minor
---

`land()` takes a `round`: every dispatch step id after round 0 carries `r<round>`, so a pilot that re-enters `land()` after a rerun or a new head gets fresh step ids. Round 0 keeps its existing ids. On a `GatePolicy` `allow`, `land()` records a `merge-policy` code step with the policy trace gate and the caller's `allowEvidence`, then trusts the head without opening `approve-merge`. hitl refuses automation resolvers, so an automated merge can never resolve that gate. `gate` and `deny` behave as before.
