---
"@titan-design/factory": patch
---

A strict behind head whose required check has never reported (a workflow that exists only on the base) now settles after a 10 minute grace, so land updates the branch and starts the workflow instead of waiting out the ci-wait timeout. A check that is queued or running still blocks the update.
