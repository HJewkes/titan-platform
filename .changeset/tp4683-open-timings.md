---
"@titan-design/active-work": patch
---

`active-work open` now reports per-phase timings (`load`, `archive`, `live_status`, `rank_notes`, `loop_retrieval` with its query count, and `total`) in `metadata.timings_ms`, never in the prompt. `AW_TIMING=1` prints them as one stderr line from `aw` and `active-work open`.
