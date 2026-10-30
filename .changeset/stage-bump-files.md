---
"@titan-design/explainer": patch
---

A stage's version is no longer hand-picked. Each stage keeps a frozen base value (its value before this change, so stored runs keep their keys), and a change that re-keys a stage adds a `stage-bumps/<id>.json` file naming the stages; the version appends a hash of those bump ids. Parallel pull requests that bump the same stage add two files and never collide. `pnpm stage-version:check`, run in CI by `index-version:check`, refuses an edited base value and a deleted, renamed or re-staged bump. Stage versions are unchanged.
