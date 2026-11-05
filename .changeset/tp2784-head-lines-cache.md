---
"@titan-design/factory": patch
---

Shepherd wires the codewatch anchor check to its bare git cache (TP-2784). `cacheHeadLines` reads file lines at the PR head with code-graph's `revisionLineSource` over the cache, fetching the head by sha only when `git cat-file -e` misses. `codewatchReader` now requires its `HeadLines` argument, and `workflows.ts` passes `cacheHeadLines()`.
