# @titan-design/code-parser

## 0.2.1

### Patch Changes

- c89daa1: Index `.mjs` and `.cjs` files as typescript-family sources (TP-4161). `shouldIncludeFile` and
  `getLanguageFromPath` now treat both as `typescript`, so code-graph's walk picks up ES module and
  CommonJS scripts and their symbols, imports and calls enter the graph.
- 565913d: Skip Python virtualenvs and tool caches in the source walk (TP-3688). `.venv`, `venv`, `__pycache__`,
  `.pytest_cache` and `.tox` are now excluded directories, and `walkSourceFiles` also skips any
  directory holding a `pyvenv.cfg`, so a virtualenv under any name no longer floods the graph.

## 0.2.0

### Minor Changes

- caca1a4: Move the shared tree-sitter function and class node-kind table into code-parser, exported from the dependency-free `@titan-design/code-parser/node-kinds` subpath and adding `TS_METHOD_DEFINITION`. code-graph re-exports it unchanged. style-analyzer's complexity extractor builds its function set from those constants instead of restating the strings. No behaviour change.

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
