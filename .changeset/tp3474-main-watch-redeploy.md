---
"@titan-design/factory": patch
---

Every green merge on the factory repo now queues a redeploy, including merges outside Shepherd's land step (seat-merge, bin/merge, an owner merge). serve's main CI watch writes `deploy-wanted.json` through the same queue Shepherd's redeploy step uses, so a newer queued sha is kept over an older merge it contains. The watch covers the factory repo even when no seat lists it. The `/health` deploy block now also counts the running build's lag behind main from git while no deploy is queued. It fetches main into a private ref, `refs/titan-factory/watched-main`, so a merge no one deployed raises the alarm instead of reading `behind: 0`. `shepherd status --deploy` no longer counts serve's own reading twice (TP-3474).
