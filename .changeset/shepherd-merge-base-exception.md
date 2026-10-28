---
"@titan-design/factory": minor
---

A planner can let a Shepherd run's fix rounds merge the base branch when the fix needs code that has landed there since (TP-4242). `titan-factory shepherd allow-merge-base owner/repo#N --reason <text>` records the exception on the run with the caller, and `revoke-merge-base` drops it. While it stands, a ci-red fix round's brief no longer says "Do not merge the base branch". Every fix-round brief except a conflict's then says the fixer may merge the base, and a fenced `merge-base exception` block names who allowed it and why. The exception follows a registration to the run that replaces a failed one, and one that cannot be read counts as none.
