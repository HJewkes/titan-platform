---
"@titan-design/factory": minor
---

Add `titan-factory shepherd visual-feedback-notes`: a sweep that files one active-work task per non-blank note of every answered `feedback` round in the console rounds dir, from the round's PR, frame and task initiative. It is idempotent on round id and note index, recorded in a ledger in the factory state dir, so a re-run files nothing.
