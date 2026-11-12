---
"@titan-design/factory": patch
---

The G10 hold-closure walk now starts from every file a G10 rule holds under `products/factory/src` and follows relative imports across that whole tree, not just Shepherd's directory (TP-4813). `owner-at-head.ts`, which `approval-carry.ts` imports and which defines the D21 rows the approval carry reads, is now held, as is every other factory module a held file imports, transitively. `g10-hold-closure.json` now lists paths relative to `products/factory/src`.
