---
"@titan-design/factory": patch
---

Shepherd's seat check lets a damaged seat-reviewer transcript block only the PR it reviews. A partial last record on an exited or detached reviewer now vetoes a MERGE only when the transcript's brief or a verdict block in its complete records names that PR; a transcript tied to no PR, or only to others, logs a warning and never vetoes. Each session under a seat reviewer's name is read on its own, so a damaged session no longer hides another session's FIX_FIRST.
