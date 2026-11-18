---
"@titan-design/retrieval-eval": minor
---

Add `retrieval-eval freeze`, which pins a pair file as a deduplicated, sorted set with a hash-named manifest; `run` accepts the set directory, refuses a tampered one and stamps its rows with the set id (TP-6212).
