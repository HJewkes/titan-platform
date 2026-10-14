---
"@titan-design/explainer": minor
---

Add the Q-rule registry `doctrine/rules.yaml` (`rules/v1`, 55 rules with aliases, fields, check type and `owner_support`), its loader (`loadRuleRegistry`, `parseRuleRegistry`, `resolveRule`, `unimplementedL0Rules`), and make `explainer eval l0` validate the registry and default `--rules` to the shipped file (TP-2811).
