---
"@titan-design/factory": minor
---

`service check` reports two new causes after `GitHub down`: `stale index.lock`, naming the service checkout's `.git/index.lock` by path and age when no process holds it and it is older than 10 minutes (it is never removed), and `deploy stalled`, naming the deploy alarm's causes and the last refusal reason.
