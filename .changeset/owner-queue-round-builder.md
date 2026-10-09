---
"@titan-design/owner-queue": minor
---

Add `buildOwnerRounds(items, options)`: open Decide items become `titan-review/round@2` manifests that pass `RoundSchema` from `@titan-design/review-schema` (now a dependency). One question and section per ask in input order; items a principle covers become one `Principle:` question, and one-way items never batch. Shadow-mode asks go in `after-answer` rounds and graduated categories in `shown` rounds. Each round returns bindings from question ids and shown labels back to item and option ids. The zod peer range rises to `^4.3.6`, review-schema's own.
