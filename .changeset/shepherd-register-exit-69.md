---
"@titan-design/factory": patch
---

`titan-factory shepherd register` exits 69 with one stderr line, and records nothing, when no `titan-factory serve` answers on `--port`. `--offline` keeps the old in-process registration. The read verbs still fall back to the database.
