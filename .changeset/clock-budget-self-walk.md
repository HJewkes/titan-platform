---
"@titan-design/eslint-plugin": patch
---

`no-test-clock-budget` no longer overflows the stack on a loop that walks a property of its own variable, such as `node = node.parentElement` (TP-4266). Each pass of the self-write grew the property path the rule followed, so its seen-guard never matched. The rule now stops following a name past 8 nested property reads.
