---
"@titan-design/queue-mirror": patch
---

Clears the package's typed-lint baseline: SQLite rows and events are now narrowed at runtime instead of cast. A malformed stored row or an item missing at resolution time now throws a descriptive error.
