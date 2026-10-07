---
"@titan-design/factory": patch
---

Shepherd's merge evidence now counts a PR's changed files only when the PR sits at the evidence head both before and after the list is read. A push in between leaves the files unread for that head, which gates (`files-unread`), so the visual-path and `.github` checks never judge another head's files. A seat's `visual_paths` glob that no repo-relative changed path could match now makes the seat book invalid, naming the seat, the glob and why: leading or trailing whitespace, a backslash, an empty segment (a leading, doubled or trailing `/`), or a `.` or `..` segment. Such a glob is refused, never normalised.
