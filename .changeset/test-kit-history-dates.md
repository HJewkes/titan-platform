---
"@titan-design/test-kit": minor
---

`withHistory` commits take an optional `date` and `author`, so a history test can pin each commit's date and count its authors from one `git fast-import`. A commit that names neither keeps the pinned date and fixture identity.
