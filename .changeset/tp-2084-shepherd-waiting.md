---
"@titan-design/factory": minor
---

`titan-factory shepherd waiting [--json]` lists every pending gate oldest first (gate, repo and PR, head, task, age in hours, held reason), the gates the owner answers apart from seat work (`ci-failed`, `sh-sent-back`, `stuck-behind`). It reads the same rows as `shepherd status` and writes nothing (TP-2084).
