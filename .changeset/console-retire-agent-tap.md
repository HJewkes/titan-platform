---
"titan-console": minor
---

The inbox taps a deposit's `retire-agent` op (TP-3622). The read-back comes from the factory's `owner-op.preview` and shows the agent that holds the name now: its id, state, profile, cwd and who spawned it, plus the RET-OR authority and the proposal. The console offers no tap, and says why, when the name is held by a different agent than the op names, when the agent's session has not exited, when it works on a live Shepherd run, or when the op asks for `force`. The factory's `retired` answer shows as landed with agent-chat's caveats. A `moved` answer carrying `currentAgentId` says the name changed hands.
