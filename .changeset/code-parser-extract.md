---
"@titan-design/code-parser": minor
"@titan-design/code-graph": patch
---

New package `@titan-design/code-parser` (tier 0): `parseFile`, `getSupportedLanguages`,
`shouldIncludeFile`, `isExcludedDir`, `getLanguageFromPath`, and the `ParsedFile` and
`Extractor<T>` types, moved unchanged out of `code-graph`. `web-tree-sitter` is a peer
dependency; the TypeScript and Python grammars are regular dependencies.

`code-graph` now depends on `code-parser` and drops its direct `tree-sitter-typescript` and
`tree-sitter-python` dependencies. Its public API is unchanged: it still re-exports
`ParsedFile`, `Extractor`, `parseFile`, `getSupportedLanguages`, `getLanguageFromPath` and
`shouldIncludeFile`, now from `code-parser`.
