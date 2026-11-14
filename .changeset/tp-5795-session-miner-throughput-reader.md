---
"@titan-design/session-miner": patch
---

Read throughput task files through `@titan-design/pm/node`'s `readInitiativeTasks`. Throughput now also reads `.yaml` task files, and a task file that cannot be read is reported as `read: ...` in `unparsed`.
