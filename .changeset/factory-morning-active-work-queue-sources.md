---
"@titan-design/factory": patch
---

Seat Morning queue items and open active-work `needs-decision` tasks are `QueueSource`s from `@titan-design/owner-queue` (`createMorningSource`, `createActiveWorkSource`). The digest's Morning asks now read through the Morning source, with unchanged output. Personal initiatives are left out unless asked for. `overlapReport` names every PR, task, run or gate that items from two sources both name, and says whether merge-by-keys folded them.
