---
"@titan-design/anthropic-account": minor
---

Add `readAccounts` and `accountIdentity` to `./node`, and `groupByIdentity` to the root: one `AccountUsage` row per Anthropic login, naming every config dir on it, merged with `mergeAccountReadings`. `readReadings(configDir)` returns every reading in a sessions dir.
