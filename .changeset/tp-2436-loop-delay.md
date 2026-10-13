---
"@titan-design/factory": patch
---

`titan-factory serve` logs an "event loop stalled" warning, with p99Ms and maxMs, for each 60 s window whose worst event-loop delay passes 5 s. A block that long starves workflow lease renewal, so the log now shows when one happened.
