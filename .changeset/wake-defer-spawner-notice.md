---
"@titan-design/factory": patch
---

sh-wake-implementer: a wake whose asks the spawn gate only deferred now waits up to 30 minutes (`WAKE_DEFER_MS`), not the 5-minute ask deadline, so a finished implementer is resumed once the machine has room (TP-3238). A wake no agent took messages the session that spawned the implementer's lineage with the reason and whom to resume, and the step records that as `notice`.
