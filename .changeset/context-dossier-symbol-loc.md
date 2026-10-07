---
"@titan-design/code-graph": minor
---

The context dossier shows each symbol's own LOC beside its complexity. `collectNodeMetrics` reads `symbol_loc` onto a symbol's `loc`; `SymbolLine`, `SymbolDossier` and `BlastRadiusEntry` gain an optional `loc`; and `renderContextMarkdown` prints it on the symbol complexity line (`· **loc** N`), on file symbol rows (`, loc N`) and on blast-radius rows (`; loc N`), with a dash when unmeasured.
