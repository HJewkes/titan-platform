---
"@titan-design/agent-dispatch": minor
---

Add the `./limits` subpath: `limitsSchema`, `LIMIT_DEFAULTS`, `parseLimits`, `resolveLimits`, `checkLimits`, `liftQuestion` and `grantFromAnswer`, a versioned per-pool, per-profile and per-seat limits block with time-boxed overrides that expire by themselves. `./limits/node` adds `loadLimits(path)` and `readGrants(path)`. zod becomes a peer dependency for these subpaths.
