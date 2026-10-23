---
"@titan-design/factory": patch
---

While a run's ci-wait is polling, `shepherd status` and `list` name the head that ci-wait last read, not the head of an earlier recorded step, so a PR pushed mid-wait no longer looks pinned to its old head.
