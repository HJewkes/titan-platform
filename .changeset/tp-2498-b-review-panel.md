---
"@titan-design/review-panel": minor
---

Reviewers may propose non-blocking follow-up tasks in a `Follow-ups:` section (`- <title> | <done_when> | low|medium|high`, at most five). `parseFollowUps` reads it and drops a malformed block whole with a named warning; `acceptVerdict` carries `followUps` and `followUpsWarning` on MERGE and FIX_FIRST without changing the verdict, and `reviewerBrief` teaches the section through `FOLLOW_UPS_RULE` (TP-2498 b).
