---
"@titan-design/active-work": patch
---

`open` starts live branch status as soon as `artifacts.yml` is read, so the gh and git lookups overlap the task archive pass instead of waiting behind it.
