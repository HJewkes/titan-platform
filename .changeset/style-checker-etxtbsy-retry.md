---
"@titan-design/style-checker": patch
---

Retry a tool spawn that fails with ETXTBSY, which can happen when another thread forks while a just-written script is still open.
