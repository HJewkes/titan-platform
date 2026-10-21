---
"@titan-design/factory": minor
"@titan-design/github": minor
---

Add the reconciler's `BotActionUnlogged` detector (TP-3094 C7). The backstop snapshot now reads each review's author and commit, each status's creator, and every `shepherd-train/**` branch head. The reconciler matches the bot's reviews, statuses, merges and train pushes against factory intent rows (`merge_op` for merges, a new append-only `factory_bot_intent` table for the rest), raises `ops-alarm BotActionUnlogged <repo> <kind> <id>` once per action, and marks it not-factory so it never counts as a factory approval. `BotPorts` gains the bot's `login`.
