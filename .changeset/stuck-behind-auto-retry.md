---
"@titan-design/factory": patch
---

Land retries update-branch with a growing wait (three extra rounds, recorded as `update-backoff` and `update-retry` steps) before it opens a stuck-behind gate; the gate reason names the retries.
