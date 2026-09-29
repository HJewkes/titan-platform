---
"@titan-design/factory": minor
---

`land()` takes a `round`: every dispatch step id after round 0 carries `r<round>`, so a pilot that re-enters `land()` after a rerun or a new head gets fresh step ids. Round 0 keeps its existing ids. Before any merge of an untrusted head, `land()` calls `GatePolicy.decide("merge", { headSha })` and records the decision in a `merge-policy` code step with the policy trace gate. It branches on the recorded decision, so a replay reuses it instead of asking the policy again. On `allow` the step also stores the caller's `allowEvidence`, and `land()` trusts that one head without opening `approve-merge`. hitl refuses automation resolvers, so an automated merge can never resolve that gate. An allow never extends to a head this run's update-branch built, and it does not reset the update count behind `stuck-behind`. `GatePolicy.decide` takes an optional `GateTarget`.
