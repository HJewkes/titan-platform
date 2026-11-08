---
"@titan-design/factory": patch
---

ci-wait settles a check whose newest run at the head concluded skipped or neutral, so an older concluded run of that check (a PR-edit fix-proof run skipping a failed mutants job) no longer holds the wait to its timeout. A run still in progress is still waited on, and a required context still needs a success (TP-4993).
