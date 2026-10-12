---
"@titan-design/factory": patch
---

`service deploy` keeps a failed install or build's redacted last 200 lines of stderr and stdout in `deploy-build.log` under the state dir, and the rollback record's `why` names it.
