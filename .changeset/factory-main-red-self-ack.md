---
"@titan-design/factory": patch
---

Shepherd acknowledges a red, cancelled or missing main CI read at a merge sha by itself once a main commit containing the merge is green on every required context of the base branch. The `sh-main-ci` result records that commit as `acknowledgedSha`, and no main-red or main-ci-timeout gate opens. A red with no such commit within a fresh 60-minute wait still freezes the repo, files a fix task and spawns a fixer, or asks the owner, as before.
