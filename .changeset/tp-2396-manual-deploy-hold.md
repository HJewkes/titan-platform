---
"@titan-design/factory": minor
---

Add `titan-factory service pause --set <reason>`: a manual deploy hold in `deploy-hold.json`, honoured under `deploy.lock` and by the deploy pacer like the failure pause; `service pause` and the deploy refusal show both reasons, and `--clear` lifts both.
