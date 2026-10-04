---
"@titan-design/authority": minor
"@titan-design/factory": minor
---

Add the `verdict-merge-carried-tree-equal` and `pr-kind-not-security` conditions and a separate automation row, MRG-AU-RC, that lets a MERGE verdict carry to a tree-equal head. It keeps every MRG-AU-RV condition except `verdict-merge-at-head`, which stays unchanged, and never carries `kind: security` or an unknown or missing kind. `MergeFacts` gains optional `carry` and `kind` facts. Shepherd's merge-facts collector fills `carry` only from the `sh-carry` step output and `kind` only from the run's registration.
