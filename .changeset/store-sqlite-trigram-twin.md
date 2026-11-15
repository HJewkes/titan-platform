---
"@titan-design/store-sqlite": minor
---

Add an opt-in contentless trigram twin to the span FTS tables. `spanFtsTablesDdl({ trigram: true })` (or the `spanFtsTrigram` kit key) creates `<name>_tri`; `index(span, text, { trigram: true })` writes its row, `searchTrigram(expression, limit?, scope?)` finds substrings inside tokens, and `clearIndex`, `purgeOwner`, `purgeSource` and `orphanRatio` cover both tables. Default behaviour is unchanged.
