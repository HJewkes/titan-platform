---
"@titan-design/factory": patch
---

A seat digest whose send the broker delivered but never acknowledged ("broker did not answer send_result") is no longer resent on every sweep: it is retried once after five minutes and then recorded as told. A refused send still retries on every sweep.
