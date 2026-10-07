---
"@titan-design/factory": patch
---

Shepherd's reviewer brief and fix-round brief now tell the agent to run only targeted tests on the Mac and the full suite with `ssh basement basement-suite`, never a full `pnpm test` locally.
