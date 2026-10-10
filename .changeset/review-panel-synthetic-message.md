---
"@titan-design/review-panel": minor
---

Add the optional `ReviewerMessage.synthetic` field: set only for a record the client wrote in the model's place, with the API error it names and the quota reset, read from the record's own fields and never from its text.

`acceptVerdict` now reads a usage-limit notice as a limit only when the client wrote it (a `synthetic` record naming no API error, `rate_limit` or `usage_limit_reached`); the same words written by the reviewer are a malformed verdict. A limit result keeps the notice text and, when recorded, `resetsAt`. The new `isUsageLimit` export tells a limit result apart from any other `none`.
