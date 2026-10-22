---
"@titan-design/explainer": patch
---

`spine/v1`: `parseSpine` reads a story spine's journey, architecture, constraints, item-ledger and chapter tables. `ledgerCheck` implements Q-E16 (a list holds one declared kind) and Q-E17 (every new item is ledgered and defined before its first use, in script order). `runL0` takes the spine as its fifth argument.
