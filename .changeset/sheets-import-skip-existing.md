---
"@titan-design/factory": patch
---

`dispatch sheets import --apply` reads the plan store first and skips the outcome and bets it already holds, so a re-run or a run after a partial import adds only what is missing (TP-5877).
