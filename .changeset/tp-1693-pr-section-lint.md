---
"@titan-design/decider": minor
---

Add `lintPrSection`, which checks an owner PR section for the PR URL (PR1), a what-it-does paragraph of at least two sentences (PR2), a why-asked line naming a gate class and a rule id (PR3), a pro and a con (PR4), and for a UI PR a before and after image pair per changed story or a stated reason there is none (PR5). Findings use the `AskFinding` shape of `lintAsk`, which now takes its rule id type as a parameter.
