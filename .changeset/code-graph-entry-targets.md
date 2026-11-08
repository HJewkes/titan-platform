---
"@titan-design/code-graph": patch
---

`packageEntryFileIds` now resolves extensionless and directory `main`/`bin` targets (`"main": "index"`, `"main": "./dist"`) to their indexed source files.
