---
"@titan-design/review-burden": patch
---

The `review-burden` bin also reads `git diff -M --name-status -z`, so added, removed, renamed and copied
files carry their real status. A deleted file under `storedDataGlobs` now yields a `stored-data-deleted` fact.
