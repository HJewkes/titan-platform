---
"@titan-design/factory": patch
---

`titan-factory service check` reads agent-chat's `burndown-status.json` and reports `tick failing` (one or more consecutive failures, with the file path, count and class) or `tick stale` (heartbeat older than three times its `intervalSeconds`). An absent file leaves the check unchanged, and a server cause is still reported first.
