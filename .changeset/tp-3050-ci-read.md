---
"@titan-design/review-panel": minor
"@titan-design/factory": patch
---

Reviewers no longer read CI with `gh api`, which reviewer sessions deny (TP-3050). `ReviewerBriefInput.ciChecks` carries the check-runs serve read at the reviewed head (name, status, conclusion, required) and replaces the test rule with a filtered table the reviewer judges CI from. Without it, `CI_REVIEWER_TEST_RULE` falls back to `gh pr view --json headRefOid,statusCheckRollup` and has the reviewer list `CI_UNREAD_LINE` when it cannot read CI at the head; `ciUnreadOnly` tells a FIX_FIRST whose only item is that line. `greenChecks`, which no caller set, is removed.

Shepherd's reviewers get the new fallback rule through `suiteRules`.
