---
"@titan-design/factory": patch
---

Shepherd waits out a spent GitHub core rate limit (a 403 with `x-ratelimit-remaining=0`) on a repeat-safe read step such as `ci-wait` or `await-new-head` for every reset it takes, and resumes, instead of failing the run after two waits. Secondary and unexplained limits keep the two-wait cap, and a write that met a limit is still never sent again.
