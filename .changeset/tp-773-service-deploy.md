---
"@titan-design/factory": minor
---

New `titan-factory service deploy [--expect <sha>]`: under a pid lock, and only on a clean `main` checkout, it fetches origin, diffs the running build sha to the target against the factory workspace closure plus root build inputs, and either fast-forwards and records `skipped`, or snapshots the closure's `dist`, fast-forwards, runs `pnpm install --frozen-lockfile` under the worktree `setupEnv` pin, builds the closure, restarts drained and confirms `build.sha`. A failed build or health check restores the snapshot, kickstarts and records `rolled-back`. It never runs `git reset`. `/health` gains `lastDeploy` from `deploy.json`.
