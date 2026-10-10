---
"@titan-design/pm": minor
---

`TaskSchema` gains an optional `actual` block (agent hours, review hours, USD, service wall
hours, peak context, context at first deliverable, `at`, `model`), an optional `claimedHours`
list of `{ hours, by, at }`, and an optional `started_at` datetime. `created` and `done_at` now
accept a full ISO-8601 datetime as well as `YYYY-MM-DD`. `isoDate` is unchanged.
