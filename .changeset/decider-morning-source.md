---
"@titan-design/decider": minor
---

Add the Morning owner-answers source: `morningSource({ dir })` parses `<date>.md` lists and `<date>-owner-answers.md` answers, joins each answer to its item by number, and emits ledger rows with an outcome. Lines with no readable number, numbers naming no item, and bare numbers that fit several items are counted (`onCounts`), never guessed.
