---
"@titan-design/code-read": patch
---

`paths.impact` counts the resolved findings of a deleted file in the rollup delta, and rejects a `root` above the index's repo root instead of reading paths against it.
