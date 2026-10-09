---
"@titan-design/owner-queue": minor
---

Add `staleLabel(item, evidence)`: pure stale rules that label an open item `gone-elsewhere` when its PR merged, its pinned head moved, its task is done, or its asker retired after declaring an `onNoAnswer` default other than `parked`. Exports `STALE_RULES`, `PARKED` and the `StaleEvidence`, `StaleLabel` and `StaleRule` types.
