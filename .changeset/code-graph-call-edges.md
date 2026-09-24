---
"@titan-design/code-graph": minor
---

Emit `calls` edges between symbols (TP-323). TypeScript resolves each call and `new` through the type checker; Python resolves same-file module-level names, `from <in-repo module> import` names, and `self.<name>()` on the enclosing class or a same-file base. Unresolved calls are dropped. Each edge carries its call sites' literal arguments in `attrs.sites`, and function and method symbol nodes carry `params`. New per-symbol metrics: `symbol_caller_count`, `symbol_single_caller_helper` and `symbol_constant_params`. `listEdges` and `listEdgesTouching` hide `calls` edges by default, like `references`. `INDEX_VERSION` moves to 0.18.0, so the first index after upgrading is a full one.
