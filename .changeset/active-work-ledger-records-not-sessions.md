---
'@titan-design/active-work': patch
---

Mark records written by `loop open` and `loop resolve` with `ledger: true`, and skip them when bootstrap picks the narrative session and the parallel sessions, and in `session list`, so a loop filed after the last wrap no longer reads as the last session.
