---
"@titan-design/session-analytics": patch
---

A standing reviewer row with no same-model reviewers now takes requests per PR from the newest reviewer cohort (latest session ts) instead of the session-weighted pool, and `requestsFrom` names that model. Sessions with no request after boot no longer dilute a cohort's growth. `HandoffSession` gains `lastTs`.
