---
"@titan-design/agent-lifecycle": patch
---

`listRecoverable` selects with `phase IN` the non-terminal phases instead of `phase NOT IN` the terminal ones, so SQLite uses the `agent_execution_phase` index rather than scanning every finished execution.
