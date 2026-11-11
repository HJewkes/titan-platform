---
"@titan-design/factory": patch
---

Shepherd's next action for a run waiting for a new head after a no-verdict diagnosis now names the diagnosis planner's findings instead of the implementer's fix. The phase stays `fixing`, so agent-chat's seat-watch, park blocker and custody read the run as before (TP-3820).
