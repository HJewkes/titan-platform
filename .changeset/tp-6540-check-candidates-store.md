---
"@titan-design/factory": patch
---

Add the `check_candidates` table (migration 54) and `shepherd.checkCandidates` (`off`, `record` or `propose`, default `record`). A row holds one class at one head of one PR, with each reviewer member's own verdict and every locator; `confirm` marks named heads and `since` lists rows by date. Nothing writes or gates on the table yet.
