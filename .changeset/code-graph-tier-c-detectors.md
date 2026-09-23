---
"@titan-design/code-graph": minor
"@titan-design/code-read": patch
---

Add Tier C audit detectors to code-graph (TP-322). Per symbol, for TypeScript and Python: `symbol_comment_lines`, `symbol_docstring_lines`, `symbol_body_lines`, `symbol_comment_ratio`, `symbol_narrating_comments` and `symbol_pass_through`. Per file: `except_count`, `except_density` (new unit `per100loc`) and `swallowed_except`. Add the `metric-outlier` check rule, which flags nodes of one kind strictly above a percentile of a metric over that kind in the snapshot, once `minSample` nodes (default 20) carry it. `INDEX_VERSION` moves to 0.17.0, so the first index after upgrading is a full one. code-read describes the new rule in a finding's `why`.
