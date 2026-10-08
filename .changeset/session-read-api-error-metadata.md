---
"@titan-design/session-read": patch
---

Keep a Claude record's `isApiErrorMessage`, `error`, `apiErrorStatus` and `quotaLimits` fields as native metadata entries, so a reader can tell a record the client wrote (such as the usage-limit notice) from one the model wrote.
