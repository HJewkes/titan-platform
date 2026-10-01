---
"@titan-design/factory": minor
---

Shepherd acts on a red main after its own merge. `sh-freeze` freezes the repo. `sh-file-fix-task` files one active-work task per episode over loopback rpc. The task is tagged with the (repo, merge sha) key and carries the fenced log tail. `sh-spawn-fixer` spawns one fixer per episode under a deterministic peer name, if the policy grants a fixer. A red while the episode has a fixer, the fixer's own merge included, opens `main-red-again` for the owner. A green merge that descends from the red sha unfreezes. The freeze exemption now also requires the PR's implementer to be the episode's fixer. Unfreezing requires every check that was red at the red sha to run green again. A failed bind no longer leaves an earlier store bound. New config key: `shepherd.fixer.configDir`.
