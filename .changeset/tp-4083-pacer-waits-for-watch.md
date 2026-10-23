---
"@titan-design/factory": patch
---

The deploy pacer no longer clears an asked deploy while the build that contains it is still in its health watch. It waits until deploy.json records that build and the window in deploy-window.json has closed. A rollback recorded after the spawn now lets the pacer ask again once the pause is cleared. Before, the ask was cleared mid-watch, so a rollback left nothing to redeploy until the next merge.
