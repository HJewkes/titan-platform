---
"titan-console": patch
---

Offer the gate tap on a replay-diverged gate (TP-6194). A gate joined to a live Shepherd row whose stall reason reads "replay diverged" now gets the same resolve-gate action as a healthy row, pinned to that row's PR and head, since the diverged sweep merges the parked run on the owner's merge answer at that head (TP-3918). A gate with no Shepherd row stays on the terminal with its command and reads "no live Shepherd row pins this gate's PR and head". `DIVERGED_HOLD` is removed.
