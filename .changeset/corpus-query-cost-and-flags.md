---
"@titan-design/corpus-query": patch
---

Keep a failed judge attempt's spend in `cost.json` even when a crash left it out of the run journal, and reject out-of-range `ask` flags (`--rounds`, `--concurrency`, `--budget-usd`) with an error naming the flag.
