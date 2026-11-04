---
"@titan-design/code-parser": patch
"@titan-design/code-graph": patch
---

Index `.mjs` and `.cjs` files as typescript-family sources (TP-4161). `shouldIncludeFile` and
`getLanguageFromPath` now treat both as `typescript`, so code-graph's walk picks up ES module and
CommonJS scripts and their symbols, imports and calls enter the graph.
