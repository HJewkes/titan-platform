# @titan-design/code-parser

## 0.1.0

### Minor Changes

- 336120d: New package `@titan-design/code-parser` (tier 0): `parseFile`, `getSupportedLanguages`,
  `shouldIncludeFile`, `isExcludedDir`, `getLanguageFromPath`, and the `ParsedFile` and
  `Extractor<T>` types, moved unchanged out of `code-graph`. `web-tree-sitter` is a peer
  dependency; the TypeScript and Python grammars are regular dependencies.

  `code-graph` now depends on `code-parser` and drops its direct `tree-sitter-typescript` and
  `tree-sitter-python` dependencies. Its public API is unchanged: it still re-exports
  `ParsedFile`, `Extractor`, `parseFile`, `getSupportedLanguages`, `getLanguageFromPath` and
  `shouldIncludeFile`, now from `code-parser`.

### Patch Changes

- e851dbb: Parse `.tsx` files with the tsx grammar (TP-166). `parseFile(content, path, "typescript")` now
  picks the tsx grammar when `path` ends in `.tsx`, so JSX no longer produces an error tree.
  `ParsedFile.language` still reports the language you passed, and no type changes. The file
  filter no longer accepts `.js` or `.jsx`: `getLanguageFromPath` returns `null` for them and
  `shouldIncludeFile` returns `false`, where before they passed the filter and `parseFile`
  rejected them.

  Metric values for `.tsx` files change in `code-graph`. Cognitive and cyclomatic complexity,
  nesting depth, function counts, and symbol line spans were computed from error trees before
  and are now computed from clean ones. Symbols the broken parse invented disappear, and
  declarations it missed appear. On titan-design's `packages/ui/src`, files with parse errors
  fell from 518 to 6, and `cognitive_sum` across all files rose from 1,514 to 3,451. `INDEX_VERSION`
  moves to `0.12.0`, so the first index after upgrading rebuilds every file instead of reusing
  an older snapshot's values.
