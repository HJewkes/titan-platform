---
"@titan-design/explainer": minor
---

Add the repo-explainer structure stage: `enrichStructure` returns a `structure/v1` (repo-map levels, code-read centrality and reading order, entry points, code-graph `findCallPath` call paths as map flows, edge sources) and gives each fact its `centrality`, `reading_rank`, `module` and `shape_hints`, with `E-INDEX`, `W-INDEX-PIN`, `W-NO-INDEX`, `W-UNRESOLVED`, `W-NO-CALL-PATH` and `W-NO-PROTOCOL` diagnostics.
