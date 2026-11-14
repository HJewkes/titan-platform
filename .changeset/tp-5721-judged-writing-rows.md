---
"@titan-design/explainer": minor
---

Add `explainer eval writing --judge <config>` (TP-5721): a hallmark-judge call and a term-extractor call, with
verbatim-quote checks and a canary, add `writing:hallmark-marks` and `writing:words-per-term` (errors) and
`writing:terms-first-400` (report-only). Thresholds live in the `judged` block of `doctrine/writing-gate.json`; a
failed call or an unmarked canary leaves the gated rows unmeasured, which fails the verdict.
