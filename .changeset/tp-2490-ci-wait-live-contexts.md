---
"@titan-design/github": patch
---

`ciWait` re-reads the base's required contexts on every poll instead of once, so a context the ruleset drops mid-wait no longer keeps the wait pending until timeout. A re-read that fails, or comes back empty while a list is recorded, keeps the last list and reports the error through `onReadError`.
