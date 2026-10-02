---
"@titan-design/workflow": patch
---

Hydrate no longer reopens a gate whose row is missing. A run paused on an `assisted` or `authorize` gate that finds no row on resume goes to `recovery_required`, and its `workflow_recovery_required` event carries the `gateId`. Restoring the row lets the next hydrate resume; `cancel` ends the run.
