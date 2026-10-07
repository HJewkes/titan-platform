---
"@titan-design/factory": patch
---

Land retries update-branch with a growing wait (three extra rounds, each a recorded `update-backoff` step before an ordinary `update-branch` step) before it opens a stuck-behind gate; the gate reason names the retries.
