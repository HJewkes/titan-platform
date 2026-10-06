---
"@titan-design/code-graph": patch
---

Abstract classes, `function*` declarations and generator expressions bound to a `const` now get symbol nodes with line spans, and every generator gets function-count, cyclomatic, cognitive and per-symbol metrics. A nested function or generator expression also adds cognitive nesting. Both checks now read their function node types from shared sets in scope-path. `INDEX_VERSION` moves to 0.22.0, so existing indexes rebuild.
