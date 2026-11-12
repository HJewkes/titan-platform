---
"@titan-design/factory": patch
---

ci-wait reads a failure that a newer skipped or neutral run of the same check at the same head hides (a PR-edit fix-proof run skipping every job) as red, instead of waiting on it to the timeout, and the ci-red wake brief hands that failure to the fixer. A skip with no earlier failure still settles; a run still in progress is still waited on; required-context rules are unchanged (TP-4993).
