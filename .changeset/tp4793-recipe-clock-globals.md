---
"@titan-design/factory": patch
---

TP-4793: seven recipe files (freeze-hold, main-rerun, merge-order-steps, release, review-cause, train, land-pr) no longer name the `Date` or `fetch` globals; they reach them through `time-iso.ts` and `ambient-fetch.ts`. No step id, order or recorded input changes.
