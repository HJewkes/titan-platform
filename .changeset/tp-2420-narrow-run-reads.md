---
"@titan-design/workflow": minor
"@titan-design/factory": patch
---

Stop parsing every registered run on serve's hot paths (TP-2420). `WorkflowRunStore.statuses` reads each run's status without its step results, and `WorkflowRunStore.page` reads runs an id-ordered page at a time, optionally only those finished since a cutoff; the factory host exposes the store as `runs`. Shepherd's watch rows load only the runs a read wants: `list` by state, `status` by repo and PR, `waiting` the unfinished and gated runs, and the seat digest only finished runs their seat has not heard of. Pending gates are read once per call instead of once per registration. Those reads and the reverts sweep, which now pages the revert window's completed runs, yield the event loop every 10 ms.
