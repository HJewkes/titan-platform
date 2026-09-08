---
"@titan-design/code-graph": minor
---

Extract `@titan-design/code-graph` from codewatch's `@codewatch/graph` (TP-9).

That package did the job of both a store and a code graph. This splits it along that seam:
`database.ts` / `migrations.ts` / `db-rows.ts` / `schema.sql` are gone, replaced by a
`CodeGraphStore` composing `@titan-design/store-sqlite`'s snapshot registry, snapshot-scoped
entity table, and content-addressed blob cache, plus four code-specific domain tables
(`edge`, `metric`, `id_alias`, `file_fingerprint`) this package owns. No `better-sqlite3`
dependency and no `@codewatch/*` imports remain.

Everything code-specific came across: the tree-sitter parser (TypeScript, TSX, Python), the
walk, the ts-morph extractor with its per-symbol reference layer, role classification,
generated-file detection, git-rename id aliasing, and the three-tier content-hash →
structural-hash → full-extract reuse. `indexPaths(store, { paths, ref, … })` mirrors
`codewatch graph index`, and the node id scheme (`<fileId>#<export>`, rooted at the git
toplevel) plus the `NodeKind`/`EdgeKind`/`role` vocabularies are byte-identical, because this
repo's own `dag:check` consumes them.

Python indexing is new: codewatch walked TypeScript only although the parser already had the
grammar. The Python extractor resolves imports by dotted path rather than by type checker.

The rules engine, the git-history metrics (churn, ownership, coupling, coverage), and the
snapshot analyses (communities, pagerank, dead code, diff, embeddings, …) are deliberately
not here; they are a follow-up layer on top of this package.
