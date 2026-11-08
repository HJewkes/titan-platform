---
"@titan-design/code-graph": minor
---

Dead-module detection can now root on package manifests. The new `packageEntryFileIds(repoRoot, fileIds)` reads every `package.json` above an indexed file and resolves `exports` (every condition and subpath, `*` patterns included), `imports` (`#` aliases), `main`, `module`, `types` and `bin` to indexed source files, mapping emitted paths back through the package tsconfig's `outDir`/`rootDir` (relative `extends` followed). Pass the result as `topDeadModules(..., { entryIds })` so a non-barrel subpath entry and what it imports no longer read as dead. Query-time only; INDEX_VERSION stays at 0.32.0 and no re-index is needed.
