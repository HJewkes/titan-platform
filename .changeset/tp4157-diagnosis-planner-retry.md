---
"@titan-design/factory": patch
---

Retry the no-verdict diagnosis planner after a spawn gate deferral (TP-4157). A deferred spawn is asked again a window later, up to 5 asks, and each gate reason is recorded in the step's `deferrals`. Before this, one rate-window refusal sent the ops notice and left the run waiting for a new head with no planner.
