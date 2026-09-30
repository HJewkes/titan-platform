---
"@titan-design/factory": patch
---

Wire the configured `postMerge` command into the production route set: `factoryRoutes` now reads it from the config file, so the land-pr post-merge chore runs instead of always recording `skipped`. A new `configuredRoutes(env, overrides)` builds that route set.
