---
"@titan-design/authority": minor
"@titan-design/factory": minor
---

Add the `verdict-merge-carried-tree-equal` condition and a separate automation row, MRG-AU-RC, that lets a MERGE verdict carry to a tree-equal head. It keeps every MRG-AU-RV condition except `verdict-merge-at-head`, which stays unchanged. `MergeFacts` gains an optional `carry` fact, and Shepherd's merge-facts collector fills it only from the `sh-carry` step output. The vocabulary has no kind fact, so the row does not yet exclude security pull requests.
