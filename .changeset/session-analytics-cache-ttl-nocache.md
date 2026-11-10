---
"@titan-design/session-analytics": minor
---

`cacheTtlWhatIf` also prices a no-cache alternative per role and per profile: every prompt token at the input rate, with no cache writes or reads. Buckets gain `noCacheNetUsd` and `noCacheCheaper`, totals gain `noCacheNetUsd`, `TtlRequestRow` gains `cacheWrite5mTokens`, and the text table adds a `no-cache net` column that flags a bucket where no cache is cheaper. The 5m-against-1h numbers are unchanged.
