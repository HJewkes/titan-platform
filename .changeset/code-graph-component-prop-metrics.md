---
"@titan-design/code-graph": minor
---

Add component prop metrics. A component is a PascalCase function with `symbol_jsx_depth > 0`, and its props are its first parameter. The props type resolves within the file only: an inline object type, or a same-file `interface`/`type`, following `extends` and `&` clauses that name same-file types; types the file does not declare (`HTMLAttributes<…>`) add nothing. `symbol_prop_count` counts the own-declared members, `symbol_bool_prop_count` the ones typed `boolean` or a union of `true`/`false`/`boolean` with `undefined`, and `symbol_unread_props` the ones the body never reads (a destructured binding with no references, or no `props.<name>` access); a `...rest` element or forwarding the whole props object gives 0. All three are absent when the props type is imported or the parameter is untyped, so each stays a pure function of one file. `INDEX_VERSION` moves to 0.24.0, so the next index of an existing store is a full re-index.
