---
'@titan-design/active-work': patch
---

A later session file may now resolve open loops opened by an earlier file that shares its session_id (reused ids, checkpoint wraps). The same file resolving itself and the ended-time ordering are still enforced.
