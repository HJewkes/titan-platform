---
"@titan-design/code-graph": patch
---

Share one tree-sitter node-kind table (`node-kinds.ts`) across declared-names, scope-path, source-metrics, cognitive-complexity, dead-code and growth-risk. Each module keeps its exact former set; no metric output changes.
