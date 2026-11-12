---
"@titan-design/active-work": minor
"@titan-design/factory": patch
---

Withhold owner-only initiatives from an agent caller's cross-initiative list verbs (TP-5453 P6b). For a caller the CLI or MCP marks as an agent, `task list`, `note list`, `source list` and `artifact list` with `--all-initiatives`, `inventory`, `list`, `audit`, `facet list` and `loop board` drop every initiative `isAgentVisible` withholds and warn with a count only. `search` drops hits with no initiative and `precedent search` ignores `--include-unclaimed` for an agent. The owner's plain terminal and the daemon's loopback RPC list as before. `inventory` rows gain `agent_visible`. `precedent extract` keeps an owner-only initiative's answers out of the decider ledger.

factory: the needs queue's active-work source marks a task personal unless `inventory` reports its initiative `agent_visible`, instead of reading the charter's human-only list.
