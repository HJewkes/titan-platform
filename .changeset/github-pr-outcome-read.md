---
"@titan-design/github": minor
---

Add `readPrOutcome` to the GitHub port: a PR's state (`open`, `closed` or `merged`), `mergedAt`, `closedAt`, each review's `{state, submittedAt}` and each commit's committed date, read in one GraphQL call over either transport. A malformed answer throws `PrOutcomeMalformed`; past `PR_OUTCOME_CAP` (100) reviews or commits `truncated` is set. `fakeGitHub()` seeds outcomes through `fake.outcomes`.
