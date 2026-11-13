---
"@titan-design/owner-queue": minor
"@titan-design/pm": minor
"@titan-design/factory": minor
"@titan-design/active-work": minor
"titan-console": minor
---

Add the owner's planning ops (TP-5453 P3b): `plan-bet-select`, `plan-outcome-edit` and `plan-freeze-set` join the owner-queue op schema. The console offers each as an owner-op tap. Its read-back comes from the factory's `owner-op.preview`: each bet's outcome, prediction and tasks, an outcome's before and after, and what a freeze stops and when it ends. The factory gates the ops to owner-remote under HV-OR and applies them through pm's plan store under the initiative's plan lock. pm's `FreezeSchema` gains an optional `ended_on`. active-work's `plan freeze add` now records `set_by: decider` and refuses `--set-by owner`. No CLI, RPC or MCP verb selects a bet, edits an outcome or ends a freeze.
