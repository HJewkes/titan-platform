---
"@titan-design/evals": patch
---

Add `src/history/graph.ts`: `openGraph(path)` opens the session graph read-only and `mergedPrs({ repos, until })` lists merged PRs from allowlisted repos (case-insensitive) merged at or before `until`, sorted by repo then number. First slice of the eval corpus history builder (TP-949).
