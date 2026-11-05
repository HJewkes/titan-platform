---
"@titan-design/review-panel": minor
---

Scope a fix-round re-review brief to the fix diff (TP-3735): `ReviewerBriefInput.scope` (`ReviewScope`: `sinceHead`, `paths`, `hunks`, `mergedBase`), given with earlier findings, swaps `gh pr diff` for `git diff <sinceHead> <head> -- <paths>`, lists the fix's line ranges, makes the `Earlier findings:` checklist required with a `- partly fixed:` option, and adds the unchanged-line rule (`Important:` plus `Class:`), the no-repeat rule and the callers rule. A scope that fails `usableScope` (shell-active path, short sha, over `MAX_SCOPE_PATHS`, no open finding) leaves the brief full; with no scope every brief is byte-identical. `shapeBrief` drops `scope`, so panel members keep the full diff. Exports `IMPORTANT_TAG` and `CLASS_TAG`.
