---
"@titan-design/session-graph": minor
---

Migration 10 recreates the `request_cost` view so a price row matches only at a model-id boundary: the model equals the prefix, or the prefix is followed by `[..]` or by `-YYYYMMDD` with an optional `[..]`. This is the rule session-analytics `findPrice` already applies. An unlisted `claude-opus-5-9` now reads `priced = 0` and shows under the cost report's `unpricedModels`, instead of being billed at the `claude-opus-5` rate.
