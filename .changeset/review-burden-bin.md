---
"@titan-design/review-burden": minor
---

Add a `review-burden` bin and a root `review:burden` script. It reads `git diff -M --numstat <base>...HEAD` and a PR body from `--body-file` or `REVIEW_BURDEN_BODY`, prints the burden table and one JSON line, and exits 0. With `--enforce` it exits 1 with a remediation message when the footer is missing or the door is under-declared.
