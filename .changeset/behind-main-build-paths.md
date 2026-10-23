---
"@titan-design/factory": patch
---

`/health` `build.behindMain` and the deploy ALARM in `titan-factory shepherd status` no longer count commits the deploy pacer skips because no changed path reaches the factory build (docs-only, other packages, version-only release bumps). An unreadable build closure or a capped compare file list still counts every commit.
