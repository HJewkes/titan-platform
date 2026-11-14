---
"@titan-design/factory": minor
---

Add `titan-factory dispatch shadow-compare --day <YYYY-MM-DD>`: scores one day of dispatcher shadow rows against the operator seat's real spawns (read-only from the agent-chat events database, plus dispatch-ledger lane claims) and writes `compare/<day>.json` and the day's `COMPARE.md` section. The rule file gains optional `compare.operator` and `compare.prefixes` keys.
