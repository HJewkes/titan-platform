---
"@titan-design/session-read": minor
---

A Claude usage observation now carries `cacheWriteSplit` (`{ ttl5m, ttl1h }`, the new exported `CacheWriteSplit` type) when the transcript's usage has a `cache_creation` object with `ephemeral_5m_input_tokens` or `ephemeral_1h_input_tokens`. The 1h rate is higher than the 5m rate, so a price needs the split rather than the `cacheWriteInput` total. A usage line with only `cache_creation_input_tokens` leaves the field absent.
