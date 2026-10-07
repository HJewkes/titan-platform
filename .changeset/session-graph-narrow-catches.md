---
"@titan-design/session-graph": patch
---

`enrichTasks`, `enrichPrs` and `resolveOrigins` now soft-fail only the caller's resolver. A write error in the graph's own store propagates out of `refreshCorpus` instead of being reported as `failed: true`.
