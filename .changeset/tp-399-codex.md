---
"@titan-design/agent": minor
---

`createCodexExecAdapter` accepts an optional dated `prices` table and fills turn usage with an estimated USD cost when the run's model has a row in force; without one, cost stays `null`. Exports `CodexPriceRow` and `priceCodexUsage`. The package ships no rates.
