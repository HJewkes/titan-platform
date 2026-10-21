---
"@titan-design/github": minor
---

Add `githubApiPool`, which gates one GitHub identity's calls: grants by priority (1 outbox and lander, 2 pacer, 3 item reads, 4 backstop) then first come first served, a single-flight mutation lane spaced 1000 ms apart, and per-(identity, call class) state that closes a limited pair until its reset, doubles only that pair's streak, and holds the identity's other classes to priority 1 meanwhile. `pool.run` returns a limited call as an `Unavailable` value instead of throwing. State goes through a `PoolStateStore`, in memory by default.
