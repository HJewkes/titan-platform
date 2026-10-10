---
"@titan-design/owner-queue": minor
---

Add `recheck(open, answered)`: drop an open item as `gone-elsewhere` when a newer answer on the same head shares its `ask:` key, and flag older shared answers as `conflict` or `reasked`. A shared component, token or topic only flags `related-answer` and never drops.
