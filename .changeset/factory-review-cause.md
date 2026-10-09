---
"@titan-design/factory": patch
---

Shepherd records why it dispatched each review on the `sh-review-intent` step. The cause is one of a closed set, such as first review, fix round, merge-up not carried with its reason, kind that does not carry, seat push, retry, hold or owner request. `shepherd stats` counts dispatches by cause per repo and ISO week, `--json` adds `reviewCauses`, and `--rereviews` prints only that section. Runs recorded before this change count as `unknown`.
