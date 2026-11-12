---
"@titan-design/factory": minor
---

`titan-factory planner wake` takes an optional `priorWindow` config: three commands (`merges`, `ownerContact`, `newRed`) that each print one line per event since `{since}`, the last spawn's time. When all three print nothing, the wake skips the review, appends a one-line record to `skipped.log` in the review dir and exits 0. A probe that fails, or a first wake with no spawn yet, runs the review as before (owner decision 556(2)).
