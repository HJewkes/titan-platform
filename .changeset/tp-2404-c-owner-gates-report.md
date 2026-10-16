---
"@titan-design/factory": minor
---

`titan-factory owner-gates report` prints, per decision class over a trailing 14-day window, the owner-answered gates, approve rate, cancelled-unanswered and median wait, built on the `shepherd stats --gates` meter. A resolve made under a grant is not counted as the owner's. A class at 95% or more approve over 20 or more answered is flagged with a proposed demotion to a rule, the reviewer or the decider, unless the audit found a bad outcome in it. The report lists the standing grants with the gates resolved under each, and `--deposit` files one two-way owner card per proposed class, once per ISO week.
