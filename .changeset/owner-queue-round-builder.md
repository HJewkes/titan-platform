---
"@titan-design/owner-queue": minor
---

Add `buildOwnerRounds(items, options)`: open Decide items become `titan-review/round@2` manifests that pass `RoundSchema` from `@titan-design/review-schema` (now a dependency). One question and section per ask in input order; items a principle covers become one `Principle:` question, and one-way items never batch. Items and principles are parsed first (an unparseable item is skipped as `invalid`), and every prompt, section text and option label is normalised to round@2's rules in one place. Asks with a shadow-mode item or a hidden pick, on an item or its principle, go in `after-answer` rounds; the rest go in `shown` rounds. Each round returns bindings from question ids and shown labels back to item and option ids. The zod peer range rises to `^4.3.6`, review-schema's own.
