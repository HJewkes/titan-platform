---
"@titan-design/openai-account": patch
---

`UsageReading`, `UsageWindow` and the nested `rate_limits` are now readonly in the public types, matching the runtime freeze. The admission test now brands corrupted readings so each window check is exercised.
