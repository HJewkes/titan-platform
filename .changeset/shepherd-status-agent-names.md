---
"@titan-design/factory": minor
---

Each `shepherd status --json` row now carries `implementer` (the registration's, or null) and `reviewer` (the agent name the newest started `sh-review` dispatched, or null), so consumers no longer guess the agents from the branch.
