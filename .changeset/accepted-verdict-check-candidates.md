---
"@titan-design/review-panel": minor
"@titan-design/factory": patch
---

An accepted verdict carries the reviewer's Check-candidates: `checkCandidatesFields(text)` returns `checkCandidates` and `checkCandidatesWarning`, which `acceptVerdict` and Shepherd's external-review acceptor spread on MERGE and FIX_FIRST alike. The verdict never reads them.
