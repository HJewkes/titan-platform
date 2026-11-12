---
"@titan-design/factory": patch
---

`titan-factory planner probe owner-contact` now prints a line for a console round whose feedback.json does not parse, instead of dropping it, so the planner window counts the owner contact it cannot date. Also tests that `redMainRuns` rejects when one conclusion query fails.
