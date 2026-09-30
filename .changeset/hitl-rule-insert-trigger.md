---
"@titan-design/hitl": patch
---

`gateRuleMigration` now installs an INSERT twin of the rule trigger, so `REPLACE INTO` and DELETE then INSERT of a rule-bound gate can no longer resolve it with a class outside the rule. A rule-bound row also refuses a status outside `pending`, `resolved`, `cancelled` and `expired` on insert and update, so `RESOLVED` cannot slip past the resolver check. Re-running the migration replaces both triggers in place.
