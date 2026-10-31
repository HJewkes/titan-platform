---
"@titan-design/active-work": patch
---

Bootstrap loop retrieval now has a 1,500 ms wall-clock budget. Once it is spent, `relatedForLoops` stops querying the remaining loops and records a `loop-retriever: budget` entry in `retrieval_degraded`, so a slow index delays launch by a bounded amount.
