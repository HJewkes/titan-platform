---
"@titan-design/session-analytics": minor
"@titan-design/active-work": minor
---

`taskLedger(db, taskId)` lists every session linked to a task, newest first, with agent, profile, span, priced cost with an unpriced flag, linked PRs and their review verdicts; `readTaskInitiative` names the task's initiative. `active-work miner ledger <task>` renders them, and refuses an agent caller for a task in an initiative that is not agent-visible.
