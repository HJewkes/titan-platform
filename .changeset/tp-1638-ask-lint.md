---
"@titan-design/decider": minor
---

Add `lintAsk`, a pure check of an owner question against the AskUserQuestion contract (rules AQ1 to AQ5: one decision, no bare ids, a `Now:` value, no pointer-only item, a recommendation), with `lintMorningList` and `lintOwnerQuestions` applying it per Morning item and per plan owner question. The Morning parser now keeps sub-item ids such as `vc-65.1` whole, in items and answers, so they never join item `vc-651`.
