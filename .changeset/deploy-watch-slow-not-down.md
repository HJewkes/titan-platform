---
"@titan-design/factory": patch
---

The deploy watch now tells a slow serve from a down one. A `/health` probe that times out while the restarted pid is still alive is retried once with a 30 s timeout and does not count toward the miss limit; only a probe with no answer from a dead pid does. A watch window in which every probe was slow rolls back with "serve answered slowly" and the latencies it saw.
