---
"@titan-design/review-workflow": minor
---

Add `preflight(snapshot, policy)`, the pure gate before any reviewer starts (`go | heal | stop | fixer`), the `preflightRead` step body that builds its snapshot over the ports, and `planForHead`, which plans a tests member whenever the proof standing needs one. `ReviewWorkflowPorts` gains a required `profiles` port, so a member whose profile is not installed goes to the fixer before dispatch (TP-3924).
