---
"@titan-design/code-parser": patch
"@titan-design/code-graph": minor
---

Parse `.tsx` files with the tsx grammar (TP-166). `parseFile(content, path, "typescript")` now
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
