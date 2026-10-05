---
"@titan-design/code-graph": minor
---

Export `computeSymbolConsumers` and `linkTestsToSources` from the browser-safe `./analysis` subpath. `parseSymbolId`, `symbolId`, and `SYMBOL_ID_SEP` move to a module with no Node imports (still re-exported where they were), and the test linker reads `couplingFor` without the git history modules, so both derivations can run in a browser.
