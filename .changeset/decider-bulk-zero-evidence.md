---
"@titan-design/decider": minor
---

A bulk answer is zero evidence. `feedbackForRow` skips a row whose outcome is `bulk` with the new `FeedbackSkip` `"bulk"`, so `isEvidence` is false for it: condense never shows it to the reflector, rejects a cite or proposal grounded in it, and still advances the domain watermark past it. `DomainRun` and `ExtractSummary` gain a `bulk` count; extraction still writes the row, since it authorizes its own items.
