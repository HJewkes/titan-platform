---
"@titan-design/owner-queue": minor
"titan-console": minor
"@titan-design/factory": patch
---

Add an inbox withdraw verb and auto-withdraw self-healed alarms (TP-4112). owner-queue gains a `./withdraw` subpath (`withdrawDeposit`, `restoreDeposit`, `withdrawMatching`, `readWithdrawal`): a seat withdraws only its own deposit, with `<id>.withdrawn` beside it and never an answer file, and each withdraw and restore is appended to the spool's `withdrawals.jsonl`. It also gains `alarmKey`, `collapseRepeats` and an optional `repeats` on `OwnerItem`. `titan-console inbox withdraw|restore|withdraw-matching` exposes it (refusal 65, unknown id 66); the inbox lists withdrawn deposits apart from answered ones and collapses open repeats of one alarm into the newest. A verified console update withdraws its earlier update-failure items, and a factory deploy that holds withdraws the open deploy alarms and incidents, both as `resolved`.
