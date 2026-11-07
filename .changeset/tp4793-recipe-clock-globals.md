---
"@titan-design/factory": patch
---

TP-4793: four recipe files (freeze-hold, main-rerun, merge-order-steps, review-cause) no longer name the `Date` global; they convert ISO strings through the pure `time-iso.ts`. No step id, order or recorded input changes.
