---
"@titan-design/active-work": patch
---

The session-index scheduler now passes the failed pass kind and its chosen backoff to `onError`, so the delta backoff log no longer keeps a second failure counter (TP-5175).
