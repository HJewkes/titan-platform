---
"@titan-design/hitl": minor
---

A gate can carry the authority rule that opened it (`GateInput.rule`, `GateRecord.rule`). A rule-bound gate refuses a resolver whose class the rule does not name, or no resolver, with `GateResolverRefused`. `gateRuleMigration(n)` adds the SQLite `rule` column and a trigger that refuses the same write from raw SQL; `migrate: true` runs it as version 3. A rule-bound gate resolves on SQLite only once `gateResolverMigration` has also run. New exports: `GateRule`, `GateRuleInvalid`, `ruleResolverRefusal`, and `gateRuleMigration` from `/sqlite`.
