---
"@titan-design/authority": minor
---

Add the MRG-AU-RM allow row and its `verdict-merge-carried-remerge-clean` condition: an automation merge may carry the dispatched reviewer's MERGE to a head that is the reviewed head plus one merge of the base, when the merge's remerge-diff is empty or touches only the repo's declared generated files. `CarryFact` gains the optional `rule`, `remergePaths` and `generatedPaths` fields.
