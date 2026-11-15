---
"@titan-design/explainer": minor
---

Add a repeatable `--visual-path <glob>` option to `explainer pr trigger`. With it the trigger also starts a decision brief for every open, non-draft PR whose changed files match a glob, read from `titan-factory shepherd prs --json` and `gh pr diff --name-only`, so a visual PR gets its video without an owner hold.
