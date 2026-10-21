---
"@titan-design/github": minor
---

`githubApiPool` reopens a closed (identity, call class) pair through a `GET /rate_limit` probe of the tripped bucket and exactly one canary call: the pair opens only when the canary returns ok, and `onAvailable(identity, class, resetAt)` fires once per reopen. An unavailable canary doubles the streak; a failed or 5xx probe re-arms at 60 s without doubling. A 401 puts the whole identity in auth state, fires `onAuthFailed` once per transition, skips the probe, and clears only on `pool.tokenChanged()` or a restart. The pool now requires a `probe` option. `probeVerdict`, `probedBucket` and `PROBE_REARM_MS` are exported. `octokitClient` gains `poolOwnsWaits` (off by default), under which the throttle never waits or retries inside a call.
