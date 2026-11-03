---
"@titan-design/agent-dispatch": minor
---

The `/roster` subpath now carries the agent-chat roster fold: `foldAgent` projects an agent's journal rows into its identity through a per-event-kind reducer table (the branching that made the original cognitive complexity 39 is gone), with `AgentLog`, `pairPresence`, `filterRoster`/`viewRoster`/`newestByName`, and the predecessor briefing section (`resolvePredecessor`) over the `/host` journal port. The predecessor briefing reads the message lookup and transcript check through a `PredecessorSource` the product supplies.
