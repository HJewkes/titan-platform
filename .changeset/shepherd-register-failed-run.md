---
"@titan-design/factory": patch
---

`shepherd register` starts a new run when the registration's run has failed, re-points the registration to it, and returns `previousRunId`. Runs in any other status still come back unchanged.
