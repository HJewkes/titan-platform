---
"@titan-design/factory": patch
---

Shepherd's seat check lets a damaged seat-reviewer transcript block only the PR it reviews. A partial last record on an exited or detached reviewer now vetoes a MERGE only when the transcript's complete records name that PR in a verdict block; any other damaged transcript logs a warning and never vetoes.
