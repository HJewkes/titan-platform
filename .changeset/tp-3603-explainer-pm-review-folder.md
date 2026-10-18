---
"@titan-design/explainer": patch
---

`gatherReview` reads review folders through `@titan-design/pm`'s `parseTopicsJudged`, `parseClaimsAudit`, `readTsv` and `readReviewPin`, and its local TSV reader is gone. A README that writes `- remote:` or `- head:` in lower case now resolves its pin instead of failing with E-PIN-UNKNOWN. Rows whose cell count differs from the header still warn W-BAD-ROW and are skipped.
