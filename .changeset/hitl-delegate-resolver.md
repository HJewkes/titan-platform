---
"@titan-design/hitl": minor
---

A gate's rule may name `delegates`, drawn only from authority's `DELEGATE_RESOLVER_CLASSES`; `create` refuses any other class with `GateRuleInvalid`. A delegate is admitted only by a store that has `authorize`, and only when `authorize` allows it; without a rule, delegates or `authorize` it is refused as before. `SqliteGateStore` runs the new `gateDelegateMigration` as version 6, which reinstalls the rule triggers so a direct write admits a delegate class only when the row's own rule names it, and refuses to create a gate with delegates on a table without it.
