---
"@titan-design/factory": patch
---

Shepherd's merge evidence now counts a PR's changed files only when the PR sits at the evidence head both before and after the list is read. A push in between leaves the files unread for that head, which gates (`files-unread`), so the visual-path and `.github` checks never judge another head's files. A seat's `visual_paths` glob that starts with `./` or `/` now makes the seat book invalid, naming the seat and the glob, since no repo-relative changed path could match it.
