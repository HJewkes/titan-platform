# @titan-design/review-panel

Review-panel types and the reviewer ports a caller satisfies

Tier 2 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

Status: types, ports and `classifyPr`. Tracked by TP-1916.

`classifyPr(facts, rules?)` returns the review class (`g10` or `standard`) and the touch flags, from signals alone. `DEFAULT_CLASS_RULES` holds the glob tables and the large threshold (400 lines; more than 12 files when a file lacks line counts); pass `rules` to override them.
