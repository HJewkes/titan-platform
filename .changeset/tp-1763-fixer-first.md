---
"@titan-design/factory": patch
---

Shepherd's spawn gate now admits the review of a red main's fix PR before any other waiting review. While that review is still asking (within twice the longest busy wait), the gate refuses every other review spawn with a reason naming it; implementer, successor and fixer spawns are unaffected. `shepherd status` names a gated review's place in the queue, for example "waiting for a spawn slot, position 2 of 3".
