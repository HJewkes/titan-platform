---
"@titan-design/factory": patch
---

Shepherd's main-CI read no longer counts a check run that workflow concurrency cancelled as red when a newer run of the same check on the same sha superseded it; a lone cancel waits instead of freezing. A freeze records whether its red came only from cancelled runs, and only such a freeze may thaw at its own red sha once each check's newest run there is green (migration 12 adds `shepherd_freeze.cancel_only`).
