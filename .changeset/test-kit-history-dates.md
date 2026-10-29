---
"@titan-design/test-kit": minor
---

`withHistory` commits take an optional `date` and `author`, so a history test can pin each commit's date and count its authors from one `git fast-import`. A commit that names neither keeps the pinned date and fixture identity. Templates are also cheaper to build: their config is written in one file append rather than one `git config` per key, and the bare origin is built only on the first `seedRepoWithOrigin`.
