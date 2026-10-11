---
"@titan-design/session-miner": minor
"@titan-design/session-analytics": minor
---

Add Q12 `insights data-quality`: one row per fault to clear before any analysis, each with a severity, its evidence and a suggested task title. It flags a graph whose newest request trails `--until` (or now) by more than `--max-lag` minutes (default 60), transcripts discovered but not indexed, an audit facet backlog, and unpriced models with requests. With `--assignments <file>` (CLI only) it also flags lines that fail `assignmentSchema`, outcomes outside `merged`, `done` and any `--known-outcome`, and agents with no session in the graph. session-analytics exports `DEFAULT_MERGED_OUTCOMES` and `DEFAULT_DONE_OUTCOMES`, the outcome words `costPerOutcome` counts by default.
