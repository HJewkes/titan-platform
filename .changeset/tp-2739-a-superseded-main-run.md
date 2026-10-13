---
"@titan-design/factory": patch
---

The Shepherd main-CI watcher reads a queued main run that a newer push superseded as superseded. Concurrency cancels such a run before any job starts, so the merge sha has no check run. Once main has moved past it, the watcher follows the newer push that contains the merge. A newer push still waiting behind the running main CI gets the queued re-checks, so it no longer opens a main-ci-timeout gate.
