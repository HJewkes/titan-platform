---
"@titan-design/code-graph": patch
---

Resolve qualified member symbols (`Box.add`, `outer.helper`) in `computeDeepAst` and in index-time signatures for non-exported methods and nested functions, which previously reported "declaration not found in source" or stored no signature.
