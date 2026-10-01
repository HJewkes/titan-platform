---
"@titan-design/workflow": patch
---

`ctx.authorize` refuses at once a gate at its id that carries no rule or was recorded under another table than F5, instead of pausing on a pending rule-less gate that could only refuse. Tests now cover a resolved rule-less gate.
