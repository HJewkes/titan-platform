---
"@titan-design/factory": patch
---

TP-3106 S4: Shepherd's 17 pending read steps are classified. Nine only read GitHub or the store (`sh-flake-check`, `sh-fix-proof`, `sh-review-stop`, `sh-main-ci`, `sh-conflict-check`, `sh-stale-base`, `sh-merge-main`, `sh-base-wait`, `sh-held-wait`), so a restart whose replay never reaches one now drops its orphan and the run goes on instead of parking. The other eight write while they wait (a hold, a release, a ready mark, a fix task, a thaw), so their orphans still park, now with that write named as the reason.
