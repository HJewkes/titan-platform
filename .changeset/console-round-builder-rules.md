---
"titan-console": minor
---

`rounds import` and `decisions file` refuse a round that breaks the round builder rules (TP-3769). These are review-schema 0.3.0's `lintRound`, vendored beside the 0.3.0 schema, plus the harness's rule that a Ship is the last question in its section. The refusal names each rule and writes nothing. Rounds already on disk keep opening.
