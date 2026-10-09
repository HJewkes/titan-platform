---
"@titan-design/factory": minor
---

Add the Shepherd coverage fold: `coverage()` counts each seat's `merged` dispatch rows in a window once per PR and reports, per seat and in total, how many a completed Shepherd run merged. The report also lists the misses and the held runs whose reason is not a charter hold class. `readCoverage()` reads the seat logs and opens the factory ledger read-only. `mergedAt` is now exported from the shepherd stats module.
