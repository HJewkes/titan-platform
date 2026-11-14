---
"@titan-design/active-work": minor
---

Decide initiative visibility once (TP-5556). `sessions/visibility.ts` is the only loader: `visibilityFor` hands readers a branded `Shown` allow list, so the charter's human-only list now narrows agent reads too, and an unreadable charter or root shows agents nothing. `inventory` rows gain `withheld_from_agents`, `migrate` refuses every caller but the owner, and the owner is now served every initiative by context graph, plan lists and precedent search.
