---
"@titan-design/evals": patch
---

Add the implement-task later-fix resolver (TP-2901 a). `laterFixCandidates` resolves a corpus row's `follow_up_fixes` and `fix_touch_14d` to their own corpus rows in PR order, deduplicated with `follow-up` winning, the case's own PR dropped, and rejects a fix the corpus lacks as `fix-not-in-corpus`. `buildCorrectedRef` commits the accepted merge plus the fix's own diff in a temp worktree of the scratch clone, with a pinned identity and date so the sha is stable, and rejects `fix-not-descendant` or `fix-not-applicable` (no `--3way`, nothing left behind). `fixTests` plans the fix's tests and carried files with fix-proof and rejects `fix-no-tests`. No GitHub call and no fetch.
