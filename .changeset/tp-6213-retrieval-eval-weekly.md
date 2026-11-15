---
"@titan-design/retrieval-eval": minor
---

Add `retrieval-eval weekly --week <YYYY-Www>`, which writes one dated measurement row per ISO week (served opened ratio per trigger and the share of sessions using a recall tool) to `weekly.jsonl`, replacing a re-run week's line. `countUptake` gains an `until` bound and a `sessionsUsingRecall` count.
