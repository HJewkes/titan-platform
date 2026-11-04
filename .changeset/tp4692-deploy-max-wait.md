---
"@titan-design/factory": patch
---

The deploy pacer now deploys the newest green sha once main has been ahead of the installed build for 45 minutes (down from 90), so steady merges inside the quiet window no longer starve a deploy. A single burst is still debounced by the quiet window. `DeployPacerOptions.maxWaitMs` overrides the bound.
