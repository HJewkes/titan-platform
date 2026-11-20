---
"@titan-design/code-graph": minor
"@titan-design/review-burden": minor
---

`detectRenames` now reads `git diff -z`, so renames of non-ASCII paths carry their real path instead of a quoted one. `RenamePair.similarity` is removed. review-burden exports `parseNameStatus`.
