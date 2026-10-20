---
"@titan-design/factory": minor
---

Shepherd answers an open approve-merge gate from the owner's console Ship (TP-2078, decisions item 97). Where `shepherd.consoleAnswers` is configured, serve runs a 60 s round ship sweep over its `roundsDir`. For each PR with a pending approve-merge gate, the round built last for that PR decides: an earlier Ship never outlives a later re-ask, Don't ship or Send back. Its answer goes through `roundMergeDecisions`, so it counts only at the gate's exact head, only on a seat-policy or authority MRG-AU gate, and only within 24 hours of the submit. A held PR stays pending. The gate resolves as owner-remote `titan-console` on channel `console:round-ship`, with the round and submit time in `confirmEvent`. The merge step still checks every hold.
