---
"@titan-design/code-graph": minor
---

Symbol ids for methods and nested declarations change, and snapshots must be re-indexed.
Same-named methods, constructors and nested functions in one file used to collapse into one
symbol node keyed by bare name, merging their spans and complexity metrics (TP-182). A symbol
id is now `<fileId>#<qualifiedName>`: `src/a.ts#Job.run`, `src/a.ts#outer.helper`,
`src/a.ts#handlers.onClick`, and `src/a.ts#<anonymous>.run` inside a callback argument. The
node's `name` is the qualified name. Top-level function, class, type and const ids do not
change, and neither do file, module and external ids, edges between files, or file-level
metrics.

`INDEX_VERSION` is now 0.14.0, so no older snapshot is reused. The first 0.14.0 run after an
older snapshot writes `id_alias` rows with the new `requalify` reason, from a bare-name id to
its qualified successor, only where exactly one declaration in the file carries that name.
`collectDeclaredNames` and `collectDeclaredSpans` now return qualified names.
