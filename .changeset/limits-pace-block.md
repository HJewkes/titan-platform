---
"@titan-design/agent-dispatch": minor
"@titan-design/coordinator": patch
---

`./limits` accepts an optional `pace` block (`mode` off, shadow or on, `buffer_points`, `finish_hours_before_reset`) and `resolvePace` fills it from `PACE_DEFAULTS`. A malformed `pace` is dropped into `ignoredSections`, reported by `checkLimits` as `invalid_pace`, and closes no pool. The version stays 1.
