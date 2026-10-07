---
"@titan-design/style-analyzer": patch
---

Fix misclassifications in the formatting, error-handling and structure extractors.

- `.editorconfig` parsing reads only the `[*]` section, so a later `[Makefile]` section no longer overrides the project-wide indent style. It skips `;` comments and drops a non-numeric `indent_size`.
- `extractFromConfig` reads only JSON `.prettierrc` and `.prettierrc.json`; it no longer hands `prettier.config.*` or YAML `.prettierrc.*` files to `JSON.parse`.
- `custom-error-class` requires a base class whose name ends in `Error` or `Exception`, so `extends ErrorBoundary` no longer counts.
- `result-type` matches a return-type identifier exactly, so `Promise<SearchResult>` no longer counts.
- Unprefixed Node builtins such as `fs` and `fs/promises`, and every Python 3.12 stdlib module such as `asyncio`, classify as `builtin` imports.
