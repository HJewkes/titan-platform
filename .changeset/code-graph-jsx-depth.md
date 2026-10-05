---
"@titan-design/code-graph": minor
---

Add JSX tree depth metrics. `symbol_jsx_depth` is the most rendered JSX elements on one ancestor chain in a function: fragments add nothing, the walk continues through `{…}` containers and inline callbacks, JSX in an attribute sits one below its owner, and a nested named function is scored on its own. `jsx_depth_max` is the file's maximum over its functions and module-scope JSX. Both are written only when greater than 0, so plain TypeScript and Python files emit neither. `max_nesting_depth` keeps its control-flow meaning. `INDEX_VERSION` moves to 0.20.0, so the next index of an existing store is a full re-index.
