---
"@titan-design/factory": patch
---

`/health` `build.behindMain` and the deploy ALARM in `titan-factory shepherd status` no longer count commits the deploy pacer skips because no changed path reaches the factory build (docs-only, other packages, version-only release bumps). An unreadable build closure, or a compare file list that is missing, empty or capped, still counts every commit, and a moved file counts by its old path too.
