---
"@titan-design/factory": patch
---

Add C28 `notAfter` steps: `StepDeclaration.notAfter` names a registered fact, and `unlessPast` skips an inserted step for a run whose record continues past it, so an in-flight run finishes instead of parking. No factory recipe declares one yet.
