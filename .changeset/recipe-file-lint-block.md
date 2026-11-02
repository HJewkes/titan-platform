---
"@titan-design/factory": patch
---

Recipe files now carry a lint block: no node:fs, child_process, net or http imports, no GitHub client values, no Date, timers, fetch, process or performance, and inline disables are ignored. `recipe-files.json` lists the recipe files and a census test keeps it complete. Twelve legacy files sit in an only-remove baseline until TP-4715 burns it down.
