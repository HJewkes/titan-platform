---
"titan-console": patch
---

Nudge rounds left unanswered over six hours: the inbox lists each one once with its recommendations stated, `titan-console rounds nudge` prints its "reply rec" line once (a `nudged.json` marker keeps it from repeating), and the new `rounds.answer-rec` owner write answers every question with its recommendation through `rounds.submit`, marked `answered-by-rec` (TP-4044).
