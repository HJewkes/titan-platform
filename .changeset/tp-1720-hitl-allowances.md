---
"@titan-design/hitl": minor
---

Add the `allowances` store option: a list of `{ resolverClass, stepId, payload }` answers that a non-owner class may give, each exact in class, gate step and payload, with a non-blank resolver id. It replaces the default class refusal for those gates only; the gate's rule and `authorize` still run after it, and a store with no allowances behaves as before.
