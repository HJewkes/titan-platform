---
"@titan-design/factory": patch
---

`/health`'s deploy block now counts a target the deploy pacer holds in deploy-wanted.json as waiting from its firstAt, and it folds in origin/main lag even while the pacer holds a target. Before this, a build many merges behind could read behind 0 with no alarm.
