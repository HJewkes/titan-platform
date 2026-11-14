---
"@titan-design/explainer": minor
---

Add `explainer eval writing --judge <config>` (TP-5721): a hallmark-judge call and a term-extractor call, with
verbatim-quote checks and a canary, add `writing:hallmark-marks` (an error over 28 per 1,000 words, a warning over
20), `writing:words-per-term` (a warning under 60) and `writing:terms-first-400` (report-only). Thresholds live in
the `judged` block of `doctrine/writing-gate.json`; a failed call or an unmarked canary leaves the rows unmeasured,
and an unmeasured hallmark row fails the verdict.
