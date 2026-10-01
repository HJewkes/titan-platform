---
"@titan-design/session-analytics": minor
"@titan-design/session-miner": minor
---

`costReport` and `cacheTtlReport` take an optional `scope` (`sessionIds`, `agentPrefix`, `roles`) that narrows every request-keyed field; with no scope the reports are unchanged. `renderCostReportSections` renders chosen sections of the cost report (`COST_REPORT_SECTIONS`) under its header, with `LIST_PRICE_CAVEAT` and the footer last. New exports: `ReportScope`, `scopeFilter`, `COST_REPORT_SECTIONS`, `CostReportSection`, `renderCostReportSections`.

`titan-miner insights <question>` runs the session-insights questions Q1 to Q4 (`spend-by-action`, `handoff-threshold`, `cache-ttl`, `wake-economics`) on the CLI, over MCP as `miner__insights__<question>`, and at `/rpc/insights.<question>`, each from one definition. Every question takes `--session`, `--agent-prefix`, `--role`, `--since` and `--until`, returns `{ question, caveat, filters, answer }` under `--json`, and prints its text renderer with the list-price caveat otherwise.
