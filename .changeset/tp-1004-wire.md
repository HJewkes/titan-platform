---
"@titan-design/factory": patch
---

Shepherd follows a merged Version Packages PR to npm once main CI is green: it records the published versions, files one fix task when the release job fails, and ends without a gate on a failure or timeout (TP-1004 S2).
