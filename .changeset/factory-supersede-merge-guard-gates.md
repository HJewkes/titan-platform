---
"@titan-design/factory": patch
---

Shepherd now supersedes a pending shepherd-merge-guard approve-merge gate (visual path, unread files, unknown required checks, head mismatch) when the pull request head moves, so resync and the serve sweep return the run to review at the new head instead of leaving the old-head gate pending.
