---
"@titan-design/factory": minor
---

Let a console tap answer `waive-proof` on an sh-sent-back gate (TP-3626). `CONSOLE_STEPS` now allows `await-new-head` and `waive-proof` on sh-sent-back, still intersected with the gate's own schema, so a sent-back gate that does not offer `waive-proof` refuses it with 403 `class`. A waiver's answer carries the record's head, which the waivable schema pins in its `anyOf` shape; the gate's, the record's and GitHub's heads must still all match.
