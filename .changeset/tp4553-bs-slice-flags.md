---
"@titan-design/factory": minor
---

A build-surface slice can set `preview: false` or `deploy: false` to skip that step for itself; the slice's outcome records the skip. Absent inherits the spec, and `true` cannot enable a step the spec leaves out.
