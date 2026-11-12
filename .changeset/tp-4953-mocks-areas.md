---
"@titan-design/code-graph": patch
---

Convention areas no longer treat `mocks` edges as links when grouping files, so a test and the module it mocks stay in separate areas unless an `imports` link joins them.
