---
"@titan-design/evals": patch
---

TP-1144d: add the implement-task corpus selector. `parseCorpusV3` reads v3 corpus rows with a loose schema and refuses a malformed line by number. `selectCandidates` skips a row with one reason (`private-repo`, `class-not-requested`, `tangled`, `brief-leak`, then from clone facts `unsupported-runner`, a two-parent merge as `tangled`, `test-only` and `no-test-change`) and orders each requested class by a seeded hash. Not yet exported; the slice e export calls it.
