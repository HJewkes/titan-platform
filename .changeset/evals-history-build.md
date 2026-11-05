---
"@titan-design/evals": patch
---

Add `titan-evals history build` and `history v2-parity`. `build` lists merged PRs from the session graph, computes each one's git facts from local bare mirrors, applies the private exclusion and writes canonical `cases.jsonl` and a per-repo `summary.json` outside every work tree; it calls no GitHub API. `v2-parity` recomputes label v2 from a gh-cache window and exits 1 on any mismatch (TP-949).
