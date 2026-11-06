---
"@titan-design/factory": patch
---

The CI timing fallback in serve now waits until 14:30Z before dispatching, so a late GitHub schedule run no longer leaves the workflow running twice.
