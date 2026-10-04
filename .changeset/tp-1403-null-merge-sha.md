---
"@titan-design/factory": minor
---

`LandOutcome`'s merged `mergeSha` is now `string | null` instead of `""` when GitHub names no merge commit. The post-merge chore then runs with `LAND_PR_MERGE_SHA` unset.
