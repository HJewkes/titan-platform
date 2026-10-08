---
"@titan-design/factory": minor
---

Shepherd's hold wait, gone sweep and release sweep read the per-repo PR snapshot instead of polling each run, so 20 held runs make no per-run `getPr` calls. The snapshot tick slows from 60 s to 5 minutes while `rate_limit` shows under 1,000 calls left, and `/health` reports it as `snapshotTick`. Every write still re-reads its PR first.
