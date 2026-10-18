---
"@titan-design/factory": patch
---

A Morning `DEPLOY HOLD:` item now holds deploys: serve's deploy pacer syncs the manual hold from the seat queue files before each tick, and `service deploy` syncs it under `deploy.lock` before it reads the holds. Removing the item clears the hold after two ticks in a row find none; the failure pause is never touched. `DeployPorts` gains `listFiles`.
