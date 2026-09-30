---
"@titan-design/agent-dispatch": minor
---

New `parkAgent(bin, name, timeoutMs?)` runs `agent-chat agent park <name>`, which removes an exited agent's clean, pushed worktree and keeps its branch. A broker refusal throws `DispatchError` with the broker's reason, and a broker that cannot be reached throws `BrokerUnavailableError`. Also exports `buildParkArgs`, `DEFAULT_PARK_TIMEOUT_MS` and `ParkResult`.
