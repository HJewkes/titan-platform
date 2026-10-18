---
"@titan-design/github": minor
---

Add `classifyGitHubFailure` and `nextResetAt`: a pure classifier that turns a failed GitHub answer into ok, unavailable (with `resetAt`, source, bucket and call class), unknown, auth or error, with the 60 s doubling to a 15 min cap (TP-3395, slice a of TP-3096). No existing export changes.
