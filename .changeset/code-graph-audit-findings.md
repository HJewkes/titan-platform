---
"@titan-design/code-graph": minor
---

Metric rules with `kind: "symbol"` now evaluate symbol nodes (TP-251); rules without `kind` keep the file graph. Metric violations carry `path`, `lineStart`, `lineEnd`, `symbol`, `evidence` and `tool`. New `Finding` type with `toFindings` and `externalToFinding`.
