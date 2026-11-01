---
"titan-console": minor
---

Add the `blockers.banner` read. It lists what has waited on the owner for longer than `TITAN_CONSOLE_BLOCKER_HOURS` (whole hours from 1 to 720, default 12), oldest first, up to five, with the full count. Three sources count: open inbox deposits that carry a `blocker`, owner gates that a live pinned Shepherd run is pending on, and unsatisfied holds on such runs. The read gets the spool from its directory and Shepherd's active rows from one cached `shepherd.list`. It never calls `inbox.list`. A source it cannot read becomes a gap line, and the other sources are still listed.
