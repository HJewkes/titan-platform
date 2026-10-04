---
"@titan-design/code-graph": minor
---

Route every file the indexer reads through a new `IndexSource` seam, set by `IndexOptions.source`. A source lists files, reads them, answers existence checks, and supplies the ts-morph `FileSystemHost` used for import resolution and tsconfig. `workingTreeSource()` is the default and wraps the existing `node:fs` calls, so output is unchanged and `INDEX_VERSION` stays at 0.19.0. `readSourceFiles`, `loadGeneratedPatterns`, `computeRoleHints`, `PythonGraphExtractor` and the extractor options take an optional source that defaults to the working tree.
