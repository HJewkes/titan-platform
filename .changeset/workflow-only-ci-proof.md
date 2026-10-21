---
"@titan-design/factory": minor
"@titan-design/review-panel": minor
---

Shepherd's fix-proof gate takes CI as the proof for a PR whose diff is only `.github/workflows/**` (changesets and the repo's declared generated files may ride along), since no unit test can cover a workflow edit (TP-3861). `sh-fix-proof` then reads the base branch's required checks from check-runs instead of the fix-proof run: it records a `workflow-ci` read citing each required check's newest run at the merge base and at the head. The read passes when a required check concluded failure at the merge base and every required check concluded success at the head; otherwise the review ends as NO_REPRO carrying the read. A passed read reaches the reviewer as `workflowCiProof`, a new `ReviewerBriefInput` field, and the brief names CI as the proof and tells the reviewer not to ask for a unit test; the tests panel member reads it in place of the missing-result line. A mixed diff keeps the fix-proof run path unchanged.
