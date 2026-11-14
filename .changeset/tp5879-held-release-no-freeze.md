---
"@titan-design/factory": patch
---

Shepherd no longer freezes a repo's other merges behind a ready Version Packages PR that is itself held, since a held release cannot land first. A merge step that waits on a hold now names its reason on the console, once for each new reason.
