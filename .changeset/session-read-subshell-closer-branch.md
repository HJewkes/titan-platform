---
"@titan-design/session-read": patch
---

Drop a subshell closer from the last word of a git or gh command, so `(git push origin feat/q)` records branch `feat/q` rather than `feat/q)`. `EXTRACT_VERSION` is now 7, so stored intents re-extract on the next backfill.
