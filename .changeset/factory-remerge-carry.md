---
"@titan-design/factory": patch
---

Shepherd carries a reviewer MERGE, and an approve-merge answer or review-round ship pick, to a head that is the reviewed head plus one merge of the base when git's remerge-diff of that merge is empty or touches only the repo's declared generated files (`generated-paths.json`). Any other resolution re-reviews and re-asks; a security run never carries. The merge evidence and the `shepherd/review` check name the rule that carried: `tree-equal`, `remerge-empty` or `remerge-generated-only`.
