---
"titan-console": minor
---

An agent page offers Retire for an exited agent that agent-chat spawned (TP-3624). The new `taps.prepare` and `taps.act` pair takes the agent id from the console's roster and the read-back from the factory's `owner-op.preview`. It then posts a plain `retire-agent` op record through the same owner-write guard and factory route as the inbox's retire. A live agent or a seat shows why there is no tap, a snapshot page points at the live console, and no path offers `--force`. The Agents roster gains a "Finished, not retired" filter.
