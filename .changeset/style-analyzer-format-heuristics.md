---
"@titan-design/style-analyzer": patch
---

Fix two source formatting heuristics. Statements and blocks closing a block body no longer count as missing trailing commas, so ordinary trailing-comma code reports `trailingCommas: true`. Comment lines no longer feed the indent-size estimate, so a file with a top-level JSDoc block no longer reports `indentSize: 1`.
