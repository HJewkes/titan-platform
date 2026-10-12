---
"@titan-design/factory": patch
---

The deploy watch now tells a slow serve from a down one. A `/health` probe that times out while the restarted pid is still alive is retried once with a 30 s timeout; an answer on the retry is slow and does not count toward the miss limit, while no answer still does, whether or not the pid is alive. A watch window in which every probe was slow rolls back with "serve answered slowly" and the latencies it saw.
