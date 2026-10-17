---
"@titan-design/factory": patch
---

Shepherd's `sh-review` step reads CI at the reviewed head itself and puts it in the reviewer brief (TP-3050). `ciChecksAt` reads the PR's base, the required contexts the same way land reads them, and the head's check-runs. It returns the newest Actions run for each check name, the required contexts other apps post, and a `missing` row for each required context with no run. `shepherd/review` is left out. When any of those reads fails it returns no table, and the brief falls back to the reviewer reading `statusCheckRollup` itself. `greenChecksAt`, which had no caller, is replaced.
