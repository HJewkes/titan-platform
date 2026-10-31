---
"@titan-design/code-graph": minor
---

`canonicalRole` and `canonicalEdgeKind` now return `string` instead of `NodeRole` and `EdgeKind`. Both pass an unaliased name through as given, so the narrower return type was not true. No runtime change. A caller that assigns the result to `NodeRole` or `EdgeKind` must now narrow it itself.
