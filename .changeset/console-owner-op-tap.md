---
"titan-console": minor
---

Tap a deposit's typed owner op from the inbox (TP-3939 S7). A deposit whose `op` is `merge-at-head` gets an `owner-op` tap: `inbox.prepare` reads it back from the factory's `owner-op.preview` (live head, title, base, hold and authority row, with the deposit's words labelled as the asker's proposal), and `inbox.act` writes a record naming the `op` at the previewed head and posts it to the factory's console-action route. A `resolve-gate` or `release-hold` op maps onto the live Shepherd row's own action. A land run's approve-merge gate, which has no Shepherd row, is now tappable at the head its prompt names. The factory's `accepted` answer reads as "Merge queued".
