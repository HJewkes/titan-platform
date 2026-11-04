---
"@titan-design/factory": patch
---

The deploy pacer no longer clears an asked deploy while the build that contains it is still in its health watch. It waits until deploy.json records that build and the window in deploy-window.json has closed, or until 30 minutes after the window if the deployer died without recording anything. When that containing deploy rolls back, the pacer asks the deployer once for origin/main after the pause is cleared. A newer main deploys; a main that is still the rolled-back sha is held, and the ask is dropped after the stale timeout. Before, the ask was cleared mid-watch, so a rollback left nothing to redeploy until the next merge.
