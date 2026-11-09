---
"@titan-design/code-parser": minor
---

Export the complexity node-type tables (`TS_NESTING_TYPES`, `PY_NESTING_TYPES`, `TS_BRANCH_TYPES`, `PY_BRANCH_TYPES`) and the `cyclomaticOf` and `nestingDepthOf` walkers, so code-graph and style-analyzer count cyclomatic complexity and nesting depth from one table. `nestingDepthOf` takes `{ flattenElseIf: true }` to keep an `else if` chain flat.
