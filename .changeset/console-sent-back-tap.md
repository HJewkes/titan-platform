---
"titan-console": minor
---

Tap an sh-sent-back gate from the inbox (TP-3939 S8). A sent-back gate joined to a live Shepherd row gets a "Wait for new head" tap whose one decision is `await-new-head`, taken from the gate's own options: `abandon` and `waive-proof` are never offered, and a gate whose options lack `await-new-head` stays on the terminal. The read-back says the run waits for the implementer's next pushed head and nothing merges, and so does the outcome message. The decision log records the decision the tap gave.
