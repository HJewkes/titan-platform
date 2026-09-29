---
"@titan-design/factory": minor
---

Add the land-pr `post-merge` step: after a merge it runs the configured `postMerge.argv` with `execFile` and no shell, passing `LAND_PR_REPO`, `LAND_PR_NUMBER` and `LAND_PR_MERGE_SHA` in the environment. It records the exit and redacted output tails, or `skipped` when no command is configured. The step is routed `park`, so a crash mid-chore holds the run for a human instead of repeating the chore. A malformed `postMerge` config key fails the config load.
