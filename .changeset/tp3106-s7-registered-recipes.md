---
"@titan-design/factory": patch
"@titan-design/review-workflow": patch
---

The factory host refuses to open a workflow that declares a step with no registry entry, and a call to an unregistered step id fails the run. The recipe docs gain a `## Steps` table marking each AGENT and OWNER step, and a doc lint matches the markers to the registry. The review-workflow README gains the same table for `reviewHead`.
