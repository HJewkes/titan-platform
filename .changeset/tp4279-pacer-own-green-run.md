---
"@titan-design/factory": patch
---

The deploy pacer deploys only a sha whose own ci.yml push run on main concluded success when it decides (TP-4279). An ask whose run is in progress, cancelled or skipped falls back to the newest older green sha, and a GitHub read that fails holds the deploy. `service deploy --expect` now builds exactly the asked sha: it no longer widens a skip to origin/main or turns a past-ask after a rollback into an origin/main deploy, and the pacer no longer re-asks for origin/main after a rollback.
