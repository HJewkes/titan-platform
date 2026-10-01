---
"@titan-design/factory": minor
---

Shepherd routes every reviewed green head through one table keyed by run state, GitHub's `mergeable_state` and the review outcome. A PR that went behind during a MERGE review updates its branch instead of gating. A silent or timed-out reviewer gets a fresh reviewer at the same head. A head that moved starts a new round, and a PR merged or closed elsewhere ends the run. A run held for a named reviewer spawns no reviewer and takes that reviewer's verdict. `approve-merge` opens only for a conflict that survived one fixer attempt, 3 failed review rounds, or a policy that did not allow the merge, and its prompt names which. `titan-factory serve` cancels a gated run once its PR merges or closes elsewhere. `sh-wake-implementer` messages a live implementer, requires a new turn within 5 minutes, and sends one fallback resume or message. `gate resolve` exits 0 when it repeats the answer a run already took.
