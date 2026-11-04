---
"@titan-design/tool-guard": patch
---

Remember each guarded-path answer by list, home and path. A script names the same few paths in every line, and since the patterns run as a linear-time NFA (TP-4223), testing each one every line made a 34 KiB script take seconds to check (TP-4255).
