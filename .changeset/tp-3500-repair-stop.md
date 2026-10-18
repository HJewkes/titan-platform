---
"@titan-design/factory": minor
---

Shepherd repair stop: `shepherd repair-stop <owner/repo#N | owner/repo:<glob>> --reason`, `repair-go` and `repair-stops` set, clear and list a seat's stop on fixer dispatch. While a stop covers a run, Shepherd wakes and resumes no fixer for it and spends no repair, even under `heldRepair: on` with a g10 hold, and the release path is unchanged. Migration 31 adds `shepherd_repair_stop` and the `repair-stop` and `repair-go` event kinds.
