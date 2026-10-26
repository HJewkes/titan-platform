---
"@titan-design/explainer": minor
---

`gatherReview` reads a review's `explainer-skim.json` into `skim` facts (new kinds `actor` and `job`) and its lifetime `structural/graph-report.json` at the pin into `history` facts (new kinds `hotspot` and `silo`), warning `W-NO-SKIM`, `W-NO-HISTORY` or `W-HISTORY-PIN`. Adds the `skimFacts` and `historyFacts` parsers.
