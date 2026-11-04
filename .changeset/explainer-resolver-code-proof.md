---
"@titan-design/explainer": patch
---

Resolve a HOW beat's code proof that carries no excerpt (TP-4093). A new `code-proof` resolver row sends `{HOW, code-proof, items or statement}` to the `proof` beat, voiced at the code band, where the resolver used to refuse it with `E-RESOLVE-NO-ROW`. The resolve stage's doctrine hash now covers the resolver rows, so a table edit re-keys the stage instead of reusing a resolve chosen by the old table.
