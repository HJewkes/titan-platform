---
"@titan-design/factory": minor
---

Add `titan-factory service check [--port <n>] [--json]`: a read-only diagnosis that exits 0 when `/health` answers from the launchd pid with `github` ok, and otherwise prints one line naming the first cause (not loaded, stale pid, crash loop, stale build, GitHub down).
