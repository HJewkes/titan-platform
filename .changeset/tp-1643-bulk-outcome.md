---
"@titan-design/decider": minor
---

Add a `bulk` outcome for one answer that accepts several decisions at once. `LedgerRow` gains `covers`, the number of decisions the answer covered when it can be read (null by default, so v1 and v2 rows still parse). Reading a row turns an `accept` or `amend` into `bulk` when the new pure `bulkSignal` detector fires on the recommendation and answer: a source count above one, an accept phrase with a plural defaults noun, or a question range or count. `other`, `redirect`, `none` and null outcomes never change, and re-reading a row gives the same row.
