---
"@titan-design/hitl": patch
---

`gateRuleMigration` now installs a BEFORE INSERT guard, so `REPLACE INTO` and `INSERT OR REPLACE` of a pending rule-bound gate id with a different or NULL rule abort instead of leaving a rule-less resolved row. It needs no `recursive_triggers` pragma. An UPDATE that adds a rule to a rule-less row aborts, and is pinned by a test. Re-running the migration still leaves one trigger per event.
