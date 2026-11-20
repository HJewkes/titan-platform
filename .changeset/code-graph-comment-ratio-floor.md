---
"@titan-design/code-graph": minor
---

`symbol_comment_ratio` is 0 for a function body under `COMMENT_RATIO_MIN_BODY_LINES` (6) code rows, so a one-line body with a one-line provenance note no longer scores 1.0. `computeSourceMetrics` takes `{ commentRatioMinBodyLines }` to change the floor. `INDEX_VERSION` moves to 0.37.0, so an existing index recomputes the ratio instead of carrying the old value forward.
