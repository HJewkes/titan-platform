---
"@titan-design/anthropic-account": minor
---

Add `readAccounts` and `accountIdentity` to `./node`, and `groupByIdentity` to the root: one `AccountUsage` row per Anthropic login, naming every config dir on it, merged with `mergeAccountReadings`. `readReadings(configDir)` returns every reading in a sessions dir as an `ObservedReading`, keeping a status line's validated `prompt_cache` stamp so the merge dates its figures by the last API response. `parseObservedReading` is exported from the root.
