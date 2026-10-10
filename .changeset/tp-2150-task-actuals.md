---
"@titan-design/session-analytics": minor
---

Add `taskActuals(minerDb, tasks, options)`: one row per done task with implementer and reviewer agent-hours (request gaps capped at 15 minutes, with the 5 and 60 minute values alongside), list-price cost, implementer session count and first and last request, linked PRs with merge time, and the flags `no-impl-session`, `weak-link`, `multi-task`, `reopened` and `unpriced`. Initiatives come from an allowlist option. A session's role comes from its spawn profile (`fable-implementer` and `fable-reviewer` included); a linked session that counts toward neither total is reported in `unmappedSessions` and raises `unmapped-role`.
