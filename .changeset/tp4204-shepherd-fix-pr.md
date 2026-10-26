---
"@titan-design/factory": minor
---

Add `titan-factory shepherd fix-pr <owner/repo> <pr> [--episode <n>]` (registry command `shepherd.fix-pr`, served over `/rpc` like `shepherd thaw`). It marks a registered pull request as the open main-red episode's fix through `FreezeStore.markFixPr`, recording the caller, so a seat's own fix merges through the freeze while every other pull request stays held. It refuses a repo with no open main-red freeze, an `--episode` that is not the open one, a pull request not registered with Shepherd, and a second fix PR for the same episode. A run waiting on `repo-not-frozen` merges on its next read with no re-register, and an approve-merge gate the freeze alone caused is superseded at once. `shepherd freezes` now also lists open main-red episodes with their fix task, fixer and fix PR, and the marked PR's `timeline` shows the mark (TP-4204).
