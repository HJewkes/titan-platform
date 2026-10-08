---
"@titan-design/code-graph": minor
---

Stop counting each TS/JS `else if` as a nesting level. `nestingDepthOf` now adds no depth for an `if_statement` that is the direct child of an `else_clause`, matching ESLint `max-depth` and Sonar. `max_nesting_depth` and `symbol_max_nesting` drop for functions with else-if chains (a loop over a flat four-arm chain goes from 5 to 2). Python `elif` was already flat and is now pinned by tests. `INDEX_VERSION` is now 0.26.0 so stored nesting values are not reused.
