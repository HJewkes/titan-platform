---
"@titan-design/factory": minor
---

`titan-factory shepherd waiting [--json]` lists every pending gate oldest first (gate, repo and PR, head, task, age in hours, held reason), the gates the owner answers apart from seat work (`ci-failed`, `sh-sent-back`, `stuck-behind`). Each gate says whether the head it names is still the run's head (`headIsCurrent`), the verb exits 1 when an owner gate is over 24 hours old, and the digest lists the five oldest owner gates. It reads the same rows as `shepherd status` and writes nothing (TP-2084).
