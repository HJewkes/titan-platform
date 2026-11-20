---
"@titan-design/retrieval": minor
"@titan-design/active-work": patch
---

`@titan-design/retrieval` exports the query-term helpers `meaningfulTerms`, `orExpression`, `deriveQuery`, `selectTerms`, `documentFrequencyCap` and `DF_CAP_FLOOR`, with the `DerivedQuery` and `DocumentFrequency` types. They turn prose into a rarity-ranked FTS5 OR expression. active-work now imports them instead of its own copies.
