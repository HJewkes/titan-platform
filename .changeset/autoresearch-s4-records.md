---
"@titan-design/autoresearch": minor
---

Record what S4's readers need instead of keeping it in memory. Each round records `ar-summary:<r>` (best, against, kept and superseded ids, the ratchet move, the first planner answer's quota misses and whether it retried), and the run records `ar-end` with its stop reason and hands an `ar-registry:<phase>` row to the new optional `registry` port. Owner ideas enter through a recorded `ar-inbox:<r>` step and the optional `ownerIdeas` port, queued with `source: "owner"`. A new `autoresearch-validate` workflow (`runValidatorLook`) runs one milestone look through the optional `validate` port, whose strict aggregate refuses per-case keys; `target.json` gains `validator {runs, maxLooks}`. `finalOutcomes`, `RunSettingsSchema`, `ForkScheduleSchema`, `ProposalSchema`, `AgainstSchema` and the new record schemas are exported.
