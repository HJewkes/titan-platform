---
"titan-console": patch
---

`rounds.list` carries a withdrawn round's `withdrawnReason`, and #/rounds lists withdrawn rounds in their own Withdrawn section with that reason, linking a `superseded-by:<id>` reason to the round that replaced it, instead of dropping them from the page; Open still lists only open rounds. Window focus, or the tab turning visible, refetches `rounds.list`, so a round withdrawn after the page loaded leaves Open without a reload (TP-4335).
