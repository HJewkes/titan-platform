---
"@titan-design/review-panel": minor
---

`acceptVerdict` takes a MERGE's exact `CI-policy: unchanged` line at Head+1 when every other CI-policy-labelled line is prose (bold, a list item or a sentence) that only says nothing changed (an allowlist: `unchanged`, or no files under `.github/` changed), instead of refusing the block as `ci_policy_malformed`. A weakened reading still wins. A refusal where every other labelled line is prose is recorded as the new `ci_policy_prose` refusal, apart from `ci_policy_malformed` (TP-4391).
