---
"@titan-design/factory": minor
"titan-console": patch
---

`needs.list` takes `fyi: "count"`, which leaves open `lens: fyi` items out and returns only `fyiCount`, and the serving factory keeps its active-work leg (the needs-decision tasks) between reads: fresh for 15 s, then served for up to 6 h while one refresh runs behind. A failed read is never kept. Gates, broker items and Morning queues are still read live. The console's inbox asks for `fyi: "count"` and adds the factory's count to its own (TP-4757).
